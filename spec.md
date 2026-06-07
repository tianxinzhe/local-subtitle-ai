# Local AI Subtitles Pro — 技术规范书

## 一、核心架构与技术选型

### 1.1 运行环境
- **平台**: Chrome 扩展 (Manifest V3)
- **最低版本**: Chrome 120+
- **运行时**: Service Worker + Side Panel + Tab Page
- **核心约束**: 100% 本地离线运行，零服务器依赖

### 1.2 技术栈

| 层级 | 技术选型 | 用途 |
|------|----------|------|
| 扩展框架 | Chrome Extension MV3 | 整体容器 |
| JS 构建 | esbuild (Node.js) | 打包 bundler |
| ASR 引擎 | `@huggingface/transformers` (transformers.js) v3.8.1 | Whisper Tiny/Base 推理 |
| ONNX 运行时 | onnxruntime-web v1.26.0 (WASM) | 模型推理后端 |
| 翻译引擎 | Chrome Built-in AI (Gemini Nano) → ONNX NLLB-200 兜底 | 语境翻译 |
| 音频处理 | Web Audio API (AudioContext, OfflineAudioContext) | 解码/重采样/切片 |
| 本地缓存 | IndexedDB (模型权重) + chrome.storage.local (配置/凭证) | 双层持久化 |
| 用户界面 | Vanilla JS + CSS3 (无框架) | 侧边栏 + 播放器 |
| 国际化 | 8 语种 (en/zh/ja/ko/fr/de/es/ru) | i18n 全覆写方案 |

### 1.3 ASR 引擎配置
- **默认模型**: `Xenova/whisper-tiny` (INT8 量化版, ~75MB)
- **可选模型**: `Xenova/whisper-base` (INT8 量化版, ~140MB)
- **加载方式**: 动态下载 → IndexedDB 持久缓存 → 二次启动 1 秒加载
- **推理精度**: INT8 量化 (`dtype: 'q8'`)
- **执行后端**: WASM (SIMD)

### 1.4 翻译引擎策略
```
优先: Chrome Built-in AI (window.ai.translator / Gemini Nano)
         ↓ 不可用时
兜底: ONNX NLLB-200 Distilled 600M (INT8)
         ↓ 模型未下载时
降级: 返回原文
```

- Gemini Nano 支持语对: en → zh/ja/ko/fr/de/es/pt/ru/ar/hi/th/vi/it/nl/pl/tr/id/ms
- NLLB-200 支持: 99+ 语种 (flores-200 code 体系)

---

## 二、空间分工与视觉交互布局

### 2.1 右侧智能侧边栏 (Side Panel)

**布局结构**:
```
┌─────────────────────────┐
│  [logo] Local AI Subtitles│
├─────────────────────────┤
│  [ ● 激活本地 AI ]      │  ← 一键激活按钮
│  [████░░░░] 45%         │  ← 进度条 (加载时)
│  [status badge]         │  ← 状态指示器
├─────────────────────────┤
│  Source: [auto  ▼]      │
│  Target: [中文    ▼]    │  ← 99 语种下拉
├─────────────────────────┤
│  ┌─────────────────┐    │
│  │  📁 Drop file   │    │  ← 文件拖拽/选择区
│  │  (up to 50GB)   │    │
│  └─────────────────┘    │
│  [🎤 Capture Tab Audio] │  ← 标签页内录
│  [⚡ Full Speed]        │  ← 极速模式
├─────────────────────────┤
│  Subtitles (42)         │
│  ┌──────────────────┐   │
│  │ 00:12 ────────   │   │  ← 瀑布流字幕卡
│  │ Hello world      │   │
│  │ 你好世界          │   │
│  ├──────────────────┤   │
│  │ 00:15 ────────   │   │
│  │ How are you?     │   │
│  │ 你还好吗？        │   │
│  └──────────────────┘   │
├─────────────────────────┤
│  [📥 Export Bilingual]  │  ← 导出按钮
│                    [⚙️] │  ← 设置
└─────────────────────────┘
```

**关键交互**:
- 激活按钮: 闲置 → 进度条动画 → 就绪呼吸灯
- 瀑布流: 自动滚动，增量追加，支持 RTL 渲染
- 设置面板: 覆盖层弹出 (UI 语言/ASR 模型/字号/颜色/背景透明度)

### 2.2 左侧专属播放器 (Tab Page)

**布局结构**:
```
┌──────────────────────────────────┐
│  ┌────────────────────────────┐  │
│  │                            │  │
│  │      <video>               │  │
│  │                            │  │
│  │  ┌────────────────────┐   │  │
│  │  │  Hello world       │   │  │  ← CSS 级字幕叠加
│  │  │  你好世界           │   │  │
│  │  └────────────────────┘   │  │
│  │                            │  │
│  └────────────────────────────┘  │
│  Source: [auto ▼] Tgt: [中文 ▼] │  ← 控制栏
│                          [⛶]    │  ← 全屏按钮
└──────────────────────────────────┘
```

**支持的文件交互**:
- 从侧边栏选择文件 → 自动打开播放器并加载
- 直接拖拽文件到播放器页面
- 拖拽到视频容器区域

---

## 三、核心业务逻辑

### 3.1 离线本地文件模式 (Local File Mode)

#### 玩法 A：边看边译 (实时)
```
用户点击播放
     ↓
timeupdate 事件 (每 2 秒 / 间隔 1 秒检测)
     ↓
extractCurrentAudio() ← Web Audio API 解码当前片段
     ↓
ASR_REQUEST → Service Worker → Side Panel
     ↓
Whisper.transcribe() → 识别文本
     ↓
SentenceMerger.feed() → 合并完整语句
     ↓
SlidingWindow.getContext() → 获取前 3 句上下文
     ↓
Translator.translate() → 翻译 (Gemini / NLLB)
     ↓
SUBTITLE_SYNC → Service Worker → Player Tab
     ↓
displaySubtitle() → CSS 字幕渲染
```

#### 玩法 B：极速全量提取 (10x-20x)
```
用户勾选 [⚡ Full Speed]
     ↓
播放器无声播放 (或模拟时间轴前进)
     ↓
定时提取 → ASR → 瀑布流持续追加
     ↓
完成后 [📥 Export SRT] 一键收割
```

### 3.2 网页实时音频内录 (Tab Capture Mode)
```
用户点击 [🎤 Capture Tab Audio]
     ↓
chrome.tabCapture.capture({ audio: true, video: false })
     ↓
MediaStream → AudioContext.createMediaStreamSource()
     ↓
AudioWorklet / ScriptProcessor → 5 秒切片
     ↓
流式 ASR + 翻译管道 (同文件模式)
     ↓
实时瀑布流追加 (无字幕渲染到播放器)
```

### 3.3 消息路由 (Runtime Messaging)

```
Side Panel                    Service Worker                Player Tab
    │                              │                           │
    ├── OPEN_PLAYER ───────────────► (create tab) ────────────►│
    │                              │                           │
    │◄─── ASR_REQUEST ──────────────┤◄─── ASR_REQUEST ──────────│
    │                              │                           │
    ├── ASR_RESULT ────────────────►├─── ASR_RESULT ───────────►│
    │                              │                           │
    ├── TRANSLATE_RESULT ──────────►├─── TRANSLATE_RESULT ─────►│
    │                              │                           │
    ├── SUBTITLE_SYNC ─────────────►├─── SUBTITLE_SYNC ───────►│
    │                              │                           │
    ├── CAPTURE_START ─────────────►│                           │
    │◄─── CAPTURE_STREAM_READY ─────┤                           │
    │                              │                           │
    ├── CONFIG_CHANGE ─────────────►├─── CONFIG_UPDATED ──────►│
    │◄─── CONFIG_UPDATED ───────────┤                           │
    │                              │                           │
    │◄─── PLAYER_CLOSED ────────────┤◄─── PLAYER_CLOSED ────────│
```

---

## 四、核心算法流水线

### 4.1 智能断句合并 (Sentence Merging)

**动机**: Whisper 常因说话人停顿将一句话劈成多段。

**策略**:
```
feed(chunk) → 缓存到 _buffer
     ↓
检查尾部标点 ∈ {。！？.!?\n} 或 buffer 长度 > 语言阈值
     ↓
是 → flush() 返回合并后的完整句子
否 → 继续缓存，返回 null
```

**语言阈值** (字符数):
| 书写体系 | 阈值 |
|----------|------|
| CJK | 30 |
| Latin | 50 |
| Thai | 60 |
| Arabic | 40 |
| Devanagari | 50 |

### 4.2 滑动窗口语境算法 (Sliding Window)

**动机**: 单句翻译缺乏上下文，人称/敬语/梗无法对齐。

**策略**:
```
维护容量为 3 的双语队列 [sent-3, sent-2, sent-1]
     ↓
翻译第 4 句时组装 Prompt:
  "Context: [前 3 句原文]
   Translate: [当前第 4 句原文]"
     ↓
推入新句 → 队列超限时 shift()
```

### 4.3 双语 SRT 导出

**流程**:
```
内存 _segments[] 数组持续追加
     ↓
exportBilingual(): 逐条格式化
     ↓
序号 → hh:mm:ss,ms → 原文/译文换行 → 空行
     ↓
Blob → URL.createObjectURL → chrome.downloads.download
```

**SRT 格式**:
```
1
00:00:12,500 --> 00:00:15,000
Hello, how are you today?
你好，今天怎么样？

2
00:00:15,500 --> 00:00:18,000
I'm doing great, thanks!
我很好，谢谢！
```

---

## 五、模块清单

| 文件 | 职责 |
|------|------|
| `manifest.json` | MV3 声明、权限、CSP |
| `service-worker.js` | 消息路由、标签页管理、生命周期 |
| `sidepanel/index.html` | 侧边栏 DOM |
| `sidepanel/script.js` | 侧边栏逻辑：激活/文件/捕获/翻译/导出 |
| `sidepanel/style.css` | 侧边栏样式 |
| `player/index.html` | 播放器 DOM |
| `player/script.js` | 播放器逻辑：视频控制/字幕渲染/音频提取 |
| `player/style.css` | 播放器样式 |
| `modules/config.js` | 配置读写 (chrome.storage.local) |
| `modules/i18n.js` | 国际化引擎 |
| `modules/languages.js` | 99 语种定义、RTL 判断、断句标点 |
| `modules/whisper.js` | Whisper ASR 引擎封装 |
| `modules/translator.js` | Gemini Nano + ONNX NLLB 翻译引擎 |
| `modules/audio-processor.js` | 音频解码/重采样/切片 |
| `modules/sentence-merger.js` | 断句合并 |
| `modules/sliding-window.js` | 滑动窗口语境队列 |
| `modules/srt-exporter.js` | SRT 格式化与下载 |
| `modules/indexeddb-cache.js` | IndexedDB 模型缓存 |
| `build.js` | esbuild 打包脚本 |
| `_locales/*/messages.json` | 8 语种翻译资源 |
| `shims/` | Node.js 内置模块垫片 (esbuild 用) |
| `dist/libs/` | onnxruntime-web WASM 运行时 (构建后) |
| `dist/` | 构建产物 (加载此目录作为扩展) |

---

## 六、构建与部署

### 6.1 构建命令
```bash
npm run build
# → 清除 dist/
# → 复制静态资源 (HTML/CSS/icons/locales/libs)
# → esbuild 打包 3 个入口
#   - service-worker.js → dist/service-worker.js
#   - sidepanel/script.js → dist/sidepanel/script.js
#   - player/script.js → dist/player/script.js
```

### 6.2 加载方式
- Chrome → 扩展管理 → 加载已解压的扩展 → 选择 `dist/` 目录

### 6.3 开发流程
1. 修改源代码文件
2. `npm run build`
3. 在扩展管理页面点击 ↻ 刷新

---

## 七、已知限制与待办

| 状态 | 项目 | 说明 |
|------|------|------|
| ⚠️ | ONNX INT8 图形优化 | ORT 1.26.0 WASM `TransposeDQWeightsForMatMulNBits` 过不去，已临时禁用 graph optimizations |
| 📋 | WebGPU 加速 | 当前仅 WASM 后端；可添加 `device: 'webgpu'` 利用 GPU 推理 |
| 📋 | Web Codecs 硬解 | 当前使用 Web Audio API 软解，未集成 `VideoDecoder`/`AudioDecoder` |
| 📋 | 全量提取模式 | `fullSpeedMode` 开关存在但未接入真正的 10x-20x 批量管道 |
| 📋 | 付费变现 | `extensionPayToken` 配置项存在但无逻辑；无免费/Pro 限制 |
| 📋 | 图标 | `icons/` 目录下为 1×1 占位符，需替换为正式 PNG |
| 📋 | NLLB 模型包 | `models/nllb-200-distilled-600m-int8.onnx` 未下载，需要发布时附带 |
| 📋 | 错误恢复 | 网络断线/模型下载失败时无重试机制 |
| 📋 | 字幕样式 | 播放器字幕图层未实现玻璃拟态阴影背景 |

---

## 八、致谢与参考

- [transformers.js](https://github.com/huggingface/transformers.js) — HuggingFace 官方 JS 推理库
- [onnxruntime-web](https://github.com/microsoft/onnxruntime) — Microsoft ONNX Runtime Web 后端
- [Xenova Whisper 模型](https://huggingface.co/Xenova/whisper-tiny) — 浏览器端 Whisper 量化模型
- [NLLB-200](https://huggingface.co/facebook/nllb-200-distilled-600M) — Meta 多语言翻译模型

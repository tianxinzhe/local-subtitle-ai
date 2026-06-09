# Local AI Subtitles Pro — 开发决策记录

本文档记录了本项目的关键讨论与技术决策，供后续 Agent 理解上下文和设计取舍。

## 项目目标

100% 离线的 Chrome MV3 扩展，对视频进行本地字幕生成（ASR）和翻译。
核心管线：提取音频 → Whisper 转录 → 翻译。全部在用户设备上运行，无服务器依赖。

---

## 转录（Whisper ASR）优化历程

### 问题
47 分钟视频处理太慢，单线程 WASM 推理 CPU 利用率低。

### 尝试过的方案

| 方案 | 结果 | 原因 |
|------|------|------|
| WebGPU backend | ❌ 回退 | 小模型（tiny/base）GPU 开销 > 收益 |
| ORT 1.27.0-dev | ❌ 回退 | dev 版本导致 WASM pipe() 死锁 |
| `graphOptimizationLevel: 'extended'` | ❌ 回退 | 触发 `TransposeDQWeightsForMatMulNBits` bug |
| 多 Worker 并发 (`Promise.all`) | ❌ 超时 | 所有块一次性发到 Worker 队列，后面的块还没轮到就超时了 |

### 最终方案：多 Worker + 逐块串行

1. **Worker 内串行化** — 每个 Worker 内部用 `taskQueue` 链式 Promise，一个 `pipe()` 完成后才处理下一个
2. **主线程逐块分发** — 每个 Worker 处理完一块才发下一块，超时计时只算推理时间（120s）
3. **Worker 间并行** — 不同 Worker 的链独立运行，充分利用多核
4. **Worker 数计算** — 根据 `navigator.deviceMemory` 和 CPU 核心数动态分配

**关键发现**：WASM 不是线程安全的，并发 `pipe()` 调用会导致死锁。必须在 Worker 内部串行化。

### 模型选择
- 添加了模型选择弹窗，激活前选择 Whisper 模型（tiny/base/small/medium/large-v3/turbo）
- 首 Worker 从 Hugging Face 下载，后续 Worker 从 IndexedDB 缓存加载（避免磁盘 IO 饱和）
- 分块大小：60s → 30s（匹配 Whisper 原生窗口，消除 transformers.js 警告）

---

## 翻译优化历程

### 问题
NLLB-600M ONNX 模型文件不存在，翻译直接返回原文。后续即使能跑，速度也很慢。

### 尝试过的方案

| 方案 | 结果 | 原因 |
|------|------|------|
| 手动 ONNX NLLB (`dist/models/`) | ❌ 无法使用 | 模型文件未打包，无下载机制 |
| transformers.js NLLB-600M pipeline | ❌ CSP 拦截 | CDN 动态导入 `ort-wasm-simd-threaded.jsep.mjs` 被 CSP 拦截 |
| 预加载本地 `ort.min.js` | ✅ 解决 CSP | 先 `import(chrome.runtime.getURL('libs/ort.min.js'))` 再创建 pipeline |
| hf-mirror.com 镜像 | ✅ 解决墙 | 国内用户无法访问 huggingface.co，设置 `env.remoteHost` |
| Gemini Nano (`window.ai.translator`) | 部分可用 | 需要开 flags + 下载 ~1.7GB 模型，国内可能不可用 |
| Chrome 138+ `window.Translator` API | 待测试 | 新 API，使用更小模型，尚未确认可用 |
| M2M100-418M（替代 NLLB-600M） | ✅ 更快 | 小 30%（418M vs 600M），使用标准 2 字母语言代码，不需要 FLORES 映射 |
| 单个 NLLB/M2M100 逐条翻译 | ❌ 太慢 | 1312 条字幕逐条推理，CPU 利用率仅 13% |
| **并行 Worker 翻译** | ✅ 显著提升 | 2-3 个 Worker 并行处理批次，CPU 利用率提升到 70-90% |

### 核心瓶颈：MATMulNBits + 图优化

ORT 1.26.0 WASM 后端的 `TransposeDQWeightsForMatMulNBits` bug：

- `dtype: 'q8'` 使用 `MatMulNBits` 量化算子
- `graphOptimizationLevel: 'extended'` 或 `'all'` 尝试融合/优化这些算子时崩溃
- 必须设 `graphOptimizationLevel: 'disabled'` → 所有计算串行执行 → CPU 利用率低

### 当前最终方案

```
dtype: 'fp16'                    # 不用 q8（避免 MatMulNBits）
graphOptimizationLevel: 'all'    # 开满图优化
```

- fp16 模型使用标准 float 算子（`MatMul`、`Gemm`），不触发 bug
- 图优化合并计算步骤，让 WASM 跑满多核
- 模型大小 ~800MB（M2M100-418M fp16），代价是一次性下载

### 翻译引擎优先级

```
Chrome 138+ window.Translator → Chrome 131-137 window.ai.translator → M2M100-418M 多 Worker 池
```

UI 会显示当前使用的引擎（"✓ Gemini Nano" / "✓ M2M100 (3 workers)"）。

---

## 其他关键决策

### SRT Windows 兼容
- 行尾 `\r\n`（CRLF）而非 `\n`
- 去掉 BOM（`\uFEFF`）
- MIME 类型 `text/plain;charset=utf-8`（而非 `text/srt`）

### CSP 策略
```
connect-src: huggingface.co + hf-mirror.com（国内镜像）
script-src: 'self' + 'wasm-unsafe-eval'
```

### 构建系统
- esbuild 打包 5 个 entry：service-worker, sidepanel, player, whisper-worker, translate-worker
- ORT WASM 运行时从 `node_modules/onnxruntime-web/dist/` 复制到 `dist/libs/`
- Node 内置模块通过 `shims/` 桩模块处理

---

## 仍需解决的问题

1. **fp16 M2M100 首次下载** — ~800MB，在慢网络下体验差
2. **Whisper q8 仍有图优化限制** — 转录部分仍用 `dtype: 'q8'` + `graphOptimizationLevel: 'disabled'`，如果 Whisper 也有 fp16 版本，可以尝试同样的优化
3. **翻译 Worker 内存** — 每 Worker ~800MB（模型加载后），3 个 Worker ~2.4GB
4. **翻译质量评估** — 未系统对比 Gemini Nano vs M2M100 的质量
5. **多个翻译 Worker 间切片合并顺序** — 当前按 `index` 排序，但网络波动可能导致批次完成顺序不一致

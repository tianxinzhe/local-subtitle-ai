# CLAUDE.md

This file gives Claude Code guidance when working in this repository.

## Project

**Local AI Subtitles Pro** — a 100% offline, Chrome MV3 extension that generates and
translates subtitles locally. ASR runs via `@huggingface/transformers` (Whisper) on the
`onnxruntime-web` WASM backend. Translation uses Chrome Built-in AI (Gemini Nano /
Translator API) with an M2M100-418M fallback via multi-worker pool. No server dependency.

See `spec.md` for the full technical specification.

## Build & Load

```bash
npm run build      # esbuild → dist/ (clean, copy static assets, bundle entries)
```

The build (`build.js`):
- Cleans `dist/` and copies static dirs (`sidepanel/`, `player/`, `icons/`, `_locales/`) and `manifest.json`.
- Copies `onnxruntime-web` WASM runtime → `dist/libs/`.
- Bundles 5 entry points with esbuild (ESM, target chrome120):
  - `service-worker.js` → `dist/service-worker.js`
  - `sidepanel/script.js` → `dist/sidepanel/script.js`
  - `player/script.js` → `dist/player/script.js`
  - `modules/whisper-worker.js` → `dist/modules/whisper-worker.js`
  - `modules/translate-worker.js` → `dist/modules/translate-worker.js`
- Node built-ins are stubbed via `shims/`.

**Load in Chrome:** Extensions → Load unpacked → select the `dist/` directory.
After editing source, re-run `npm run build` then click ↻ on the extension card.

> Important: Chrome runs the **built `dist/` copy**, not the source files.

## Architecture

Three runtime surfaces communicate through the service worker:

- **Side Panel** (`sidepanel/`) — main UI. Model activation, file drop, tab capture,
  transcription/translation pipeline, subtitle list, SRT + audio export.
- **Player Tab** (`player/`) — dedicated video player with CSS subtitle overlay.
- **Service Worker** (`service-worker.js`) — message routing, tab management, lifecycle.

### Translation Engine Selection (priority order)

1. **Chrome Translator API** (`window.Translator` / `window.ai.translator`) — Chrome built-in,
   on-device translation model. Detected automatically at `translator.init()`.
2. **M2M100-418M Worker Pool** — fallback if Chrome API unavailable. Runs in parallel
   web workers (2-3 workers depending on CPU cores). `hf-mirror.com` for China users.

### Modules (`modules/`)

| File | Responsibility |
|------|----------------|
| `whisper.js` | `WhisperWorkerEngine`: multi-worker pool for parallel ASR. 30s chunks distributed round-robin, sequential per-worker dispatch. |
| `whisper-worker.js` | Worker entry for Whisper ASR. Message queue serializes pipeline calls to avoid WASM deadlock. |
| `translator.js` | `TranslationWorkerPool` + `GeminiEngine`. Handles engine detection and dispatch. |
| `translate-worker.js` | Worker entry for M2M100 translation. |
| `audio-processor.js` | Web Audio API decode / resample (→16 kHz mono) / chunk / tab capture |
| `sentence-merger.js` | Merge Whisper fragments into full sentences |
| `sliding-window.js` | 3-sentence bilingual context window for translation prompts |
| `srt-exporter.js` | SRT formatting + download (CRLF line endings, no BOM for Windows) |
| `config.js` | `chrome.storage.local` config read/write |
| `i18n.js`, `languages.js` | 8-language UI i18n; 99-language definitions, RTL + punctuation rules |
| `indexeddb-cache.js` | IndexedDB model-weight cache |
| `file-store.js` | Hand off large files (video) between side panel and player tab |

## Key Implementation Details

### Whisper ASR (Multi-Worker Parallel)
- `WhisperWorkerEngine` creates N workers based on `navigator.deviceMemory` and CPU cores
- Audio split into 30s chunks, distributed round-robin across workers
- **Per-worker sequential dispatch**: chunks sent one-at-a-time to each worker (not all at once)
- **Worker serialization**: each worker processes messages via `taskQueue` chain to prevent concurrent `pipe()` calls (WASM is not thread-safe)
- 120s timeout per chunk
- Model picker modal selects Whisper model (tiny/base/small/medium/large-v3/turbo) before download
- First worker downloads + loads model; remaining workers load from IndexedDB cache

### Translation (M2M100 Worker Pool)
- `TranslationWorkerPool` manages 2-3 web workers running M2M100-418M
- Batches segments (5000 chars / 100 segs max) and distributes across workers
- Each worker serializes message processing via `taskQueue`
- Model loaded via `pipeline('translation', 'Xenova/m2m100_418M')` with `dtype: 'fp16'`
- Graph optimization set to `'all'` (no MatMulNBits quantization → no ORT WASM bug)

### Translation API Support
- Chrome 138+: `window.Translator.create()` / `window.Translator.canTranslate()`
- Chrome 131-137: `window.ai.translator.create()` / `window.ai.translator.capabilities()`
- Fallback: M2M100-418M via worker pool

### SRT Export (Windows Compatible)
- Line endings: `\r\n` (CRLF), not `\n`
- No BOM (`\uFEFF`)
- MIME type: `text/plain;charset=utf-8` (not `text/srt`)

## Conventions & Gotchas

- **Audio pipeline target:** 16 kHz, mono, `Float32Array`.
- **Whisper inference blocks the main thread** (WASM). Use `nextPaint()` / `setExtractProgress()` for UI updates.
- **Exported audio must stay faithful to the source.** Keep `cleanAudio` for WAV export.
- **CSP:** `connect-src` allows Hugging Face hosts + `hf-mirror.com` for China.
- **ORT 1.26.0 WASM bug (`TransposeDQWeightsForMatMulNBits`):** Avoid `dtype: 'q8'` with
  graph optimization. Use `dtype: 'fp16'` + `graphOptimizationLevel: 'all'` instead for
  MatMulNBits-free models.
- **Transformers.js model download:** Set `env.remoteHost = 'https://hf-mirror.com'` for
  users in China. CSP must include the mirror domain.
- **Worker loading:** First worker downloads model from HF; subsequent workers load from
  IndexedDB cache. DO NOT call `load` in parallel on all workers (disk I/O saturation).
- **i18n:** `manifest.json` uses Chrome-native `__MSG_xxx__`; HTML uses `data-i18n` /
  `data-i18n-title` resolved by JS at runtime. The build warns on missing locale keys.

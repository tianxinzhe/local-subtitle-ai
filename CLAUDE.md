# CLAUDE.md

This file gives Claude Code guidance when working in this repository.

## Project

**Local AI Subtitles Pro** — a 100% offline, Chrome MV3 extension that generates and
translates subtitles locally. ASR runs via `@huggingface/transformers` (Whisper
tiny/base, INT8/q8) on the `onnxruntime-web` WASM backend. Translation uses Chrome
Built-in AI (Gemini Nano) with an ONNX NLLB-200 fallback. No server dependency.

See `spec.md` for the full technical specification (architecture, message routing,
algorithms, module list).

## Build & Load

```bash
npm run build      # esbuild → dist/  (clean, copy static assets, bundle 3 entries)
```

The build (`build.js`):
- Cleans `dist/` and copies static dirs (`sidepanel/`, `player/`, `icons/`, `_locales/`) and `manifest.json`.
- Copies `onnxruntime-web` WASM runtime → `dist/libs/`.
- Bundles 3 entry points with esbuild (ESM, target chrome120):
  - `service-worker.js` → `dist/service-worker.js`
  - `sidepanel/script.js` → `dist/sidepanel/script.js`
  - `player/script.js` → `dist/player/script.js`
- Node built-ins are stubbed via `shims/` (transformers.js pulls in node:fs/path/url etc.).

**Load in Chrome:** Extensions → Load unpacked → select the `dist/` directory.
After editing source, re-run `npm run build` then click ↻ on the extension card.

> Important: Chrome runs the **built `dist/` copy**, not the source files. Source
> edits have no effect until `npm run build` regenerates `dist/`.

`npm test` references Jest but no tests are currently configured. `npm run lint` is a no-op.

## Architecture

Three runtime surfaces communicate through the service worker (see `spec.md` §3.3 for
the full message map):

- **Side Panel** (`sidepanel/`) — main UI. Model activation, file drop, tab capture,
  transcription/translation pipeline, subtitle list, SRT + audio export. This is where
  most logic lives.
- **Player Tab** (`player/`) — dedicated video player with CSS subtitle overlay; can
  extract audio segments during playback and forward them for ASR.
- **Service Worker** (`service-worker.js`) — message routing, tab management, lifecycle.

### Modules (`modules/`)

| File | Responsibility |
|------|----------------|
| `whisper.js` | Whisper ASR engine wrapper (load + transcribe). WASM backend blocks the main thread during inference. |
| `translator.js` | Gemini Nano + ONNX NLLB translation engine |
| `audio-processor.js` | Web Audio API decode / resample (→16 kHz mono) / chunk / tab capture |
| `sentence-merger.js` | Merge Whisper fragments into full sentences |
| `sliding-window.js` | 3-sentence bilingual context window for translation prompts |
| `srt-exporter.js` | SRT formatting + download |
| `config.js` | `chrome.storage.local` config read/write |
| `i18n.js`, `languages.js` | 8-language UI i18n; 99-language definitions, RTL + punctuation rules |
| `indexeddb-cache.js` | IndexedDB model-weight cache |
| `file-store.js` | Hand off large files (video) between side panel and player tab |

## Conventions & Gotchas

- **Audio pipeline target:** 16 kHz, mono, `Float32Array`. `decodeAudioFile()` resamples
  to `TARGET_SAMPLE_RATE` (16000).
- **Whisper inference blocks the main thread** (WASM). Any long extraction loop must
  `await` a paint yield between segments or the UI (progress bar) will freeze and only
  update at the end. See `nextPaint()` / `setExtractProgress()` in `sidepanel/script.js`.
- **Exported audio must stay faithful to the source.** The ASR path applies an in-place
  gain boost to the decoded buffer for transcription accuracy — keep a pristine copy
  (`cleanAudio`) for WAV export. Avoid destructive DSP (noise gates) on exported audio;
  prefer uniform peak normalization only.
- **CSP:** `connect-src` is limited to Hugging Face hosts (for model download). No other
  network egress; the extension is offline-first by design.
- **Graph optimizations disabled** for ONNX (`graphOptimizationLevel: 'disabled'`) due to
  an ORT 1.26.0 WASM issue (`TransposeDQWeightsForMatMulNBits`). See `spec.md` §7.
- **i18n:** `manifest.json` uses Chrome-native `__MSG_xxx__`; HTML uses `data-i18n` /
  `data-i18n-title` resolved by JS at runtime. The build warns on missing locale keys.

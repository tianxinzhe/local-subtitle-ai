import { pipeline, env } from '@huggingface/transformers';

const OPT_LEVELS = ['all', 'extended', 'basic', 'disabled'];

let pipe = null;
let taskQueue = Promise.resolve();
let currentOptLevel = null;

async function loadModel(modelId, wasmPaths, remoteHost, progressCallback) {
  // Priority chain for M2M100-418M:
  // 1. q8+basic — safe (TransposeDQWeightsForMatMulNBits optimizer is in extended level, not basic)
  // 2. q8+disabled — fallback if basic also crashes
  // 3. fp32+all — fast but 1.6GB download (fp16 model file corrupted at source)
  const plans = [
    { dtype: 'q8', optLevel: 'basic' },
    { dtype: 'q8', optLevel: 'disabled' },
    { dtype: 'default', optLevel: 'all' },
  ];
  let lastErr = null;
  for (const plan of plans) {
    try {
      const opts = {
        dtype: plan.dtype,
        session_options: {
          graphOptimizationLevel: plan.optLevel,
        },
        progress_callback: progressCallback,
      };
      pipe = await pipeline('translation', modelId, opts);
      return { success: true, dtype: plan.dtype, optLevel: plan.optLevel };
    } catch (err) {
      lastErr = err;
      console.warn(`[TranslateWorker] dtype=${plan.dtype} opt=${plan.optLevel} failed: ${err.message}`);
    }
  }
  return { success: false, error: lastErr.message };
}

self.addEventListener('message', (e) => {
  const { msgId, type, payload } = e.data;

  taskQueue = taskQueue.then(async () => {
    try {
      if (type === 'load') {
        env.remoteHost = payload.remoteHost;
        env.backends.onnx.wasm.wasmPaths = payload.wasmPaths;

        const res = await loadModel(
          payload.modelId,
          payload.wasmPaths,
          payload.remoteHost,
          (p) => {
            self.postMessage({ msgId, type: 'loadProgress', payload: { ...p } });
          },
        );

        self.postMessage({ msgId, type: 'loaded', payload: res });
      } else if (type === 'translate') {
        if (!pipe) throw new Error('Worker model not loaded');

        const texts = payload.texts || [payload.text];
        console.log(`[TranslateWorker] batch=${texts.length}, src=${payload.srcLang} tgt=${payload.tgtLang}`);

        // Individual per-text pipe() calls — faster than batched in ORT WASM
        const translations = [];
        for (let k = 0; k < texts.length; k++) {
          const t0 = performance.now();
          const output = await pipe(texts[k], {
            src_lang: payload.srcLang,
            tgt_lang: payload.tgtLang,
          });
          const dt = ((performance.now() - t0) / 1000).toFixed(1);
          if (k % 5 === 0) {
            console.log(`[TranslateWorker] pipe #${k + 1}/${texts.length}: ${dt}s, len=${texts[k].length}`);
          }
          translations.push(output[0]?.translation_text || '');
        }

        const translatedCount = translations.filter(t => t.length > 0).length;
        console.log(`[TranslateWorker] done ${translatedCount}/${texts.length} translated`);

        self.postMessage({
          msgId, type: 'translateResult',
          payload: { translations },
        });
      } else if (type === 'unload') {
        pipe = null;
        self.postMessage({ msgId, type: 'unloaded' });
      }
    } catch (err) {
      self.postMessage({ msgId, type: 'error', payload: { message: err.message, stack: err.stack } });
    }
  });
});

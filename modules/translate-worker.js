import { pipeline, env } from '@huggingface/transformers';

const OPT_LEVELS = ['all', 'extended', 'basic', 'disabled'];

let pipe = null;
let taskQueue = Promise.resolve();
let currentOptLevel = null;

async function loadModel(modelId, wasmPaths, remoteHost, progressCallback) {
  // Priority: q8 (small, fast download) → fp16 (medium) → default/fp32 (large fallback)
  // q8 uses graphOpt=disabled (avoid TransposeDQWeightsForMatMulNBits ORT bug)
  // fp16/fp32 can use graphOpt=all (no MatMulNBits in these dtypes)
  // M2M100-418M: only q8 with graphOpt disabled works reliably
  // - fp16 model file is corrupted at source (InsertedPrecisionFreeCast bug)
  // - q8 + graphOpt=extended crashes (TransposeDQWeightsForMatMulNBits ORT 1.26.0 bug)
  // - disabledOptimizers option not recognized by ORT WASM backend
  const plans = [
    { dtype: 'q8', optLevel: 'disabled' },
    { dtype: 'fp16', optLevel: 'all' },
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

        const translations = [];
        for (let k = 0; k < texts.length; k++) {
          const t0 = performance.now();
          const output = await pipe(texts[k], {
            src_lang: payload.srcLang,
            tgt_lang: payload.tgtLang,
          });
          const dt = ((performance.now() - t0) / 1000).toFixed(1);
          console.log(`[TranslateWorker] pipe #${k + 1}/${texts.length}: ${dt}s, len=${texts[k].length}`);
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

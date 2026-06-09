import { pipeline, env } from '@huggingface/transformers';

let pipe = null;
let taskQueue = Promise.resolve();

self.addEventListener('message', (e) => {
  const { msgId, type, payload } = e.data;

  taskQueue = taskQueue.then(async () => {
    try {
      if (type === 'load') {
        env.remoteHost = payload.remoteHost;
        env.backends.onnx.wasm.wasmPaths = payload.wasmPaths;

        pipe = await pipeline('translation', payload.modelId, {
          dtype: 'fp16',
          session_options: { graphOptimizationLevel: 'all' },
          progress_callback: (p) => {
            self.postMessage({ msgId, type: 'loadProgress', payload: { ...p } });
          },
        });

        self.postMessage({ msgId, type: 'loaded' });
      } else if (type === 'translate') {
        if (!pipe) throw new Error('Worker model not loaded');

        const result = await pipe(payload.text, {
          src_lang: payload.srcLang,
          tgt_lang: payload.tgtLang,
        });

        self.postMessage({
          msgId, type: 'translateResult',
          payload: { text: result[0].translation_text },
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

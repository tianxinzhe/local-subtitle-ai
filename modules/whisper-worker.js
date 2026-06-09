import { pipeline, env } from '@huggingface/transformers';

const MODEL_REPO = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
  medium: 'Xenova/whisper-medium',
  'large-v3': 'Xenova/whisper-large-v3',
  'large-v3-turbo': 'Xenova/whisper-large-v3-turbo',
};

let pipe = null;
let taskQueue = Promise.resolve();

self.addEventListener('message', (e) => {
  const { msgId, type, payload } = e.data;

  taskQueue = taskQueue.then(async () => {
    try {
      if (type === 'load') {
        env.backends.onnx.wasm.wasmPaths = payload.wasmPaths;

        const model = payload.model || 'tiny';
        const modelId = MODEL_REPO[model];

        pipe = await pipeline('automatic-speech-recognition', modelId, {
          dtype: 'q8',
          session_options: { graphOptimizationLevel: 'disabled' },
          progress_callback: (p) => {
            self.postMessage({ msgId, type: 'loadProgress', payload: { ...p } });
          },
        });

        self.postMessage({ msgId, type: 'loaded' });
      } else if (type === 'transcribe') {
        if (!pipe) throw new Error('Worker model not loaded');

        const audio = new Float32Array(payload.audio);
        const opts = payload.options || {};

        const pipelineOptions = {
          return_timestamps: opts.return_timestamps || false,
          chunk_length_s: opts.chunk_length_s || 30,
          stride_length_s: opts.stride_length_s || 0,
        };

        if (opts.forceLanguage) {
          pipelineOptions.language = opts.forceLanguage;
          pipelineOptions.forced_decoder_ids = pipe.tokenizer
            .encode(`<|${opts.forceLanguage}|>`)
            .map(id => [1, id]);
        } else if (opts.language) {
          pipelineOptions.language = opts.language;
        }

        const result = await pipe(audio, pipelineOptions);

        let detectedLanguage = null;
        if (result.chunks && result.chunks.length > 0) {
          detectedLanguage = result.chunks[0].language || opts.forceLanguage || opts.language || null;
        }

        self.postMessage({
          msgId, type: 'transcribeResult',
          payload: {
            text: result.text,
            chunks: result.chunks || [],
            detectedLanguage,
            duration: audio.length / 16000,
          },
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

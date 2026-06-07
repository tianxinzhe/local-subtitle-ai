import * as Cache from './indexeddb-cache.js';
import { get } from './config.js';
import { pipeline as hfPipeline, env } from '@huggingface/transformers';

const MODEL_REPO = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
};

const MODEL_VERSION = {
  tiny: '1.0.0',
  base: '1.0.0',
};

let pipeline = null;
let modelType = null;

class WhisperEngine {
  constructor() {
    this._pipeline = null;
    this._ready = false;
    this._modelType = null;
  }

  async load(options = {}) {
    const model = options.model || await get('asrModel') || 'tiny';
    const onProgress = options.onProgress || (() => {});

    if (this._ready && this._modelType === model) {
      return;
    }

    this._ready = false;
    this._modelType = model;

    onProgress(0, 'initializing');

    try {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('libs/');
      const modelId = MODEL_REPO[model];
      const cacheKey = `whisper_${model}`;

      const cachedMeta = await Cache.getModelConfig(cacheKey);
      if (cachedMeta && cachedMeta.version === MODEL_VERSION[model]) {
        onProgress(50, 'cached');
      }

      this._pipeline = await hfPipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
        session_options: {
          graphOptimizationLevel: 'disabled',
        },
        progress_callback: (progress) => {
          if (progress.status === 'progress') {
            const pct = Math.round((progress.loaded / progress.total) * 100);
            onProgress(pct, 'downloading');
          } else if (progress.status === 'ready') {
            onProgress(100, 'ready');
          }
        },
      });

      await Cache.setModelConfig(cacheKey, {
        version: MODEL_VERSION[model],
        modelType: model,
        cachedAt: Date.now(),
      });

      this._ready = true;
      pipeline = this._pipeline;
      modelType = model;

      onProgress(100, 'loaded');
    } catch (err) {
      this._ready = false;
      throw new Error(`Whisper load failed: ${err.message}`);
    }
  }

  async transcribe(audioFloat32Array, options = {}) {
    if (!this._ready || !this._pipeline) {
      throw new Error('Whisper model not loaded. Call load() first.');
    }

    const language = options.language || null;
    const forceLanguage = options.forceLanguage || null;

    let input = audioFloat32Array;
    if (!(input instanceof Float32Array)) {
      if (input && input.array instanceof Float32Array) {
        input = input.array;
      } else if (ArrayBuffer.isView(input)) {
        input = new Float32Array(input.buffer, input.byteOffset, input.length);
      } else if (Array.isArray(input)) {
        input = Float32Array.from(input);
      }
    }

    const pipelineOptions = {
      return_timestamps: options.returnTimestamps || false,
      chunk_length_s: options.chunkLength || 30,
      stride_length_s: options.strideLength || 5,
    };

    if (forceLanguage) {
      pipelineOptions.forced_decoder_ids = this._pipeline.tokenizer
        .encode(`<|${forceLanguage}|>`)
        .map(id => [1, id]);
    }

    if (language) {
      pipelineOptions.language = language;
    }

    const result = await this._pipeline(input, pipelineOptions);

    let detectedLanguage = null;
    if (result.chunks && result.chunks.length > 0) {
      detectedLanguage = result.chunks[0].language || forceLanguage || language || null;
    }

    return {
      text: result.text,
      chunks: result.chunks || [],
      detectedLanguage,
      duration: input.length / 16000,
    };
  }

  async transcribeChunked(audioFloat32Array, options = {}) {
    const chunkDuration = options.chunkDuration || 30;
    const sampleRate = 16000;
    const chunkSize = chunkDuration * sampleRate;
    const totalChunks = Math.ceil(audioFloat32Array.length / chunkSize);
    const results = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, audioFloat32Array.length);
      const chunk = audioFloat32Array.slice(start, end);

      const result = await this.transcribe(chunk, {
        ...options,
        returnTimestamps: true,
      });

      results.push({
        index: i,
        text: result.text,
        chunks: result.chunks,
        detectedLanguage: result.detectedLanguage,
        offset: i * chunkDuration,
      });

      if (options.onChunkComplete) {
        options.onChunkComplete(i + 1, totalChunks, result);
      }
    }

    return results;
  }

  isReady() {
    return this._ready;
  }

  getModelType() {
    return this._modelType;
  }

  async unload() {
    this._pipeline = null;
    this._ready = false;
    this._modelType = null;
    pipeline = null;
    modelType = null;
  }
}

export const whisper = new WhisperEngine();
export { MODEL_REPO, MODEL_VERSION };

import * as Cache from './indexeddb-cache.js';
import { get } from './config.js';
import { pipeline as hfPipeline, env } from '@huggingface/transformers';

const MODEL_REPO = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
  medium: 'Xenova/whisper-medium',
  'large-v3': 'Xenova/whisper-large-v3',
};

const MODEL_VERSION = {
  tiny: '1.0.0',
  base: '1.0.0',
  small: '1.0.0',
  medium: '1.0.0',
  'large-v3': '1.0.0',
};

const _modelSizeCache = new Map();

async function fetchModelTotalSize(modelId) {
  if (_modelSizeCache.has(modelId)) return _modelSizeCache.get(modelId);
  try {
    const resp = await fetch(`https://huggingface.co/api/models/${modelId}`);
    if (!resp.ok) return 0;
    const data = await resp.json();
    const siblings = data.siblings || [];
    let total = 0;
    for (const sib of siblings) {
      const name = sib.rfilename || '';
      if (/\.(json|onnx|txt|tiktoken)$/.test(name)) {
        total += sib.size || 0;
      }
    }
    _modelSizeCache.set(modelId, total);
    return total;
  } catch {
    return 0;
  }
}

let pipeline = null;
let modelType = null;

class WhisperEngine {
  constructor() {
    this._pipeline = null;
    this._ready = false;
    this._modelType = null;
  }

  async load(options = {}) {
    const model = options.model || await get('asrModel') || 'base';
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

      const estimatedTotal = await fetchModelTotalSize(modelId) || 0;

      const fileProgress = new Map();
      let lastReported = -1;
      this._pipeline = await hfPipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
        session_options: {
          graphOptimizationLevel: 'disabled',
        },
        progress_callback: (progress) => {
          if (progress.status === 'progress' && progress.name) {
            fileProgress.set(progress.name, { loaded: progress.loaded, total: progress.total });
            let totalLoaded = 0;
            let totalKnown = 0;
            for (const [, f] of fileProgress) {
              totalLoaded += f.loaded || 0;
              totalKnown += f.total || 0;
            }
            const denominator = Math.max(totalKnown, estimatedTotal);
            const pct = denominator > 0 ? Math.min(97, Math.round((totalLoaded / denominator) * 100)) : 0;
            if (pct > lastReported) {
              lastReported = pct;
              onProgress(pct, 'downloading');
            }
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
    console.log('[Whisper] transcribe input:', {
      type: typeof audioFloat32Array,
      isFloat32: audioFloat32Array instanceof Float32Array,
      length: audioFloat32Array.length,
      duration: audioFloat32Array.length / 16000,
      ready: this._ready,
      pipeline: !!this._pipeline,
    });

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
    console.log('[Whisper] final input type:', input.constructor?.name, 'length:', input.length);

    const pipelineOptions = {
      return_timestamps: options.returnTimestamps || false,
      chunk_length_s: options.chunkLength || 30,
      stride_length_s: options.strideLength || 5,
    };

    if (options.prompt) {
      pipelineOptions.prompt = options.prompt;
    }

    if (forceLanguage) {
      pipelineOptions.language = forceLanguage;
      pipelineOptions.forced_decoder_ids = this._pipeline.tokenizer
        .encode(`<|${forceLanguage}|>`)
        .map(id => [1, id]);
    } else if (language) {
      pipelineOptions.language = language;
    }
    // Neither forceLanguage nor language → let Whisper freely auto-detect

    console.log('[Whisper] pipelineOptions:', { return_timestamps: pipelineOptions.return_timestamps, chunk_length_s: pipelineOptions.chunk_length_s, stride_length_s: pipelineOptions.stride_length_s, hasForcedIds: !!pipelineOptions.forced_decoder_ids });

    console.log('[Whisper] Calling pipeline...');
    const startTime = Date.now();
    const result = await this._pipeline(input, pipelineOptions);
    console.log('[Whisper] Pipeline done in', ((Date.now() - startTime) / 1000).toFixed(1) + 's');

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

class WhisperWorkerEngine {
  constructor() {
    this._fallback = null;
    this._workers = [];
    this._ready = false;
    this._modelType = null;
    this._msgId = 0;
    this._pending = new Map();
    this._usingWorker = false;
  }

  _workerCount(model) {
    // Use deviceMemory API if available (Chrome-only, returns GB)
    const memGB = navigator.deviceMemory || 8;
    const cpuCores = navigator.hardwareConcurrency || 4;
    const perWorkerMB = { tiny: 150, base: 250, small: 500, medium: 900, 'large-v3': 1800 };
    const perWorker = perWorkerMB[model] || 300;
    const maxByMem = Math.max(1, Math.floor((memGB * 1024 * 0.6) / perWorker));
    const maxByCpu = Math.max(1, Math.floor(cpuCores * 0.5));
    return Math.min(maxByMem, maxByCpu, 4);
  }

  async load(options = {}) {
    const model = options.model || await get('asrModel') || 'base';
    const onProgress = options.onProgress || (() => {});

    if (this._ready && this._modelType === model) return;

    this._ready = false;
    this._modelType = model;

    const count = this._workerCount(model);
    console.log(`[Whisper] Starting ${count} workers for model ${model}`);

    // Set up worker progress bars
    onProgress(-1, 'init', count);

    const makeCb = (idx) => (pct, stage) => {
      onProgress(pct, stage, idx);
    };

    try {
      // Worker 0 downloads model (sequential)
      await this._initWorker(model, makeCb(0));

      // Workers 1-3 load from cache (parallel)
      if (count > 1) {
        const restPromises = [];
        for (let i = 1; i < count; i++) {
          restPromises.push(this._initWorker(model, makeCb(i)));
        }
        await Promise.all(restPromises);
      }

      // Mark as cached in IndexedDB
      const cacheKey = `whisper_${model}`;
      await Cache.setModelConfig(cacheKey, {
        version: MODEL_VERSION[model],
        modelType: model,
        cachedAt: Date.now(),
      });

      this._ready = true;
      this._usingWorker = true;
      onProgress(100, 'ready');
      console.log(`[Whisper] ${count} workers ready`);
      return;
    } catch (err) {
      console.warn('[Whisper] Workers failed, fallback to direct:', err.message);
      this._terminateWorkers();
    }

    if (!this._fallback) this._fallback = new WhisperEngine();
    await this._fallback.load(options);
    this._ready = true;
  }

  async _initWorker(model, onProgress) {
    const workerUrl = chrome.runtime.getURL('modules/whisper-worker.js');
    const wasmPaths = chrome.runtime.getURL('libs/');

    const modelId = MODEL_REPO[model];
    const estimatedTotal = await fetchModelTotalSize(modelId) || 0;

    const worker = new Worker(workerUrl, { type: 'module' });
    const idx = this._workers.length;
    this._workers.push(worker);

    const fileProgress = new Map();
    let lastReported = -1;

    worker.onerror = (err) => {
      console.error(`[Whisper] Worker ${idx} crashed:`, err.message);
      for (const [msgId, pending] of this._pending) {
        if (pending.workerIdx === idx) {
          this._pending.delete(msgId);
          pending.reject(new Error(`Worker ${idx} crashed: ${err.message}`));
        }
      }
    };
    worker.onmessageerror = () => {
      console.error(`[Whisper] Worker ${idx} message error`);
      for (const [msgId, pending] of this._pending) {
        if (pending.workerIdx === idx) {
          this._pending.delete(msgId);
          pending.reject(new Error(`Worker ${idx} message error`));
        }
      }
    };

    worker.addEventListener('message', (e) => {
      const { msgId, type, payload } = e.data;
      const pending = this._pending.get(msgId);
      if (!pending) return;

      if (type === 'loadProgress') {
        if (payload.status === 'progress' && payload.name) {
          fileProgress.set(payload.name, { loaded: payload.loaded, total: payload.total });
          let totalLoaded = 0;
          let totalKnown = 0;
          for (const [, f] of fileProgress) {
            totalLoaded += f.loaded || 0;
            totalKnown += f.total || 0;
          }
          const denominator = Math.max(totalKnown, estimatedTotal);
          const pct = denominator > 0 ? Math.min(97, Math.round((totalLoaded / denominator) * 100)) : 0;
          if (pct > lastReported) {
            lastReported = pct;
            onProgress(pct, 'downloading');
          }
        } else if (payload.status === 'ready') {
          onProgress(100, 'ready');
        }
        return;
      }

      this._pending.delete(msgId);

      if (type === 'loaded') {
        pending.resolve();
      } else if (type === 'transcribeResult') {
        pending.resolve(payload);
      } else if (type === 'error') {
        pending.reject(new Error(payload.message));
      } else if (type === 'unloaded') {
        pending.resolve();
      }
    });

    await this._sendTo(idx, 'load', { wasmPaths, model });
  }

  _sendTo(workerIdx, type, payload, transfer, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const msgId = ++this._msgId;
      this._pending.set(msgId, { resolve, reject, workerIdx });
      const msg = { msgId, type, payload };
      const worker = this._workers[workerIdx];
      if (transfer) {
        worker.postMessage(msg, transfer);
      } else {
        worker.postMessage(msg);
      }
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this._pending.has(msgId)) {
            this._pending.delete(msgId);
            console.warn(`[Whisper] Timeout (${timeoutMs}ms) for msg ${msgId} to worker ${workerIdx}`);
            reject(new Error(`Timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
    });
  }

  async transcribeAll(audioFloat32Array, options = {}, onProgress) {
    if (this._usingWorker && this._workers.length > 0) {
      return this._transcribeAllViaWorkers(audioFloat32Array, options, onProgress);
    }
    // Fallback: use single sequential transcribe
    if (!this._fallback) throw new Error('Not loaded');
    const result = await this._fallback.transcribe(audioFloat32Array, { ...options, returnTimestamps: true });
    const chunks = result.chunks || [];
    const segments = [];
    for (const c of chunks) {
      if (!c.text || !c.text.trim()) continue;
      const [ts, te] = c.timestamp || [0, 0];
      segments.push({
        start: ts,
        end: te || ts + 2,
        text: c.text.trim(),
        detectedLanguage: result.detectedLanguage || options.forceLanguage || 'en',
      });
    }
    if (segments.length === 0 && result.text && result.text.trim()) {
      segments.push({
        start: 0,
        end: audioFloat32Array.length / 16000,
        text: result.text.trim(),
        detectedLanguage: result.detectedLanguage || options.forceLanguage || 'en',
      });
    }
    return segments;
  }

  async _transcribeAllViaWorkers(audioFloat32Array, options, onProgress) {
    let input = audioFloat32Array;
    if (!(input instanceof Float32Array)) {
      if (input && input.array instanceof Float32Array) input = input.array;
      else if (ArrayBuffer.isView(input)) input = new Float32Array(input.buffer, input.byteOffset, input.length);
      else if (Array.isArray(input)) input = Float32Array.from(input);
    }

    const SAMPLE_RATE = 16000;
    const CHUNK_SEC = 30;
    const chunkSize = CHUNK_SEC * SAMPLE_RATE;
    const totalChunks = Math.ceil(input.length / chunkSize);
    const numWorkers = this._workers.length;

    // Build chunk list (each chunk needs its own ArrayBuffer for transfer)
    const chunks = [];
    for (let offset = 0; offset < input.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, input.length);
      const slice = input.slice(offset, end);
      const copy = new Float32Array(slice.length);
      copy.set(slice);
      chunks.push({
        id: chunks.length,
        data: copy,
        offsetSec: offset / SAMPLE_RATE,
        durSec: (end - offset) / SAMPLE_RATE,
      });
    }

    let completedChunks = 0;

    // Assign chunks to workers round-robin, process sequentially per worker
    const workerChains = Array.from({ length: numWorkers }, () => []);
    chunks.forEach((chunk) => {
      workerChains[chunk.id % numWorkers].push(chunk);
    });

    const workerPromises = workerChains.map((chain, workerIdx) => {
      let chainPromise = Promise.resolve();
      const results = [];
      for (const chunk of chain) {
        chainPromise = chainPromise.then(async () => {
          try {
            const res = await this._sendTo(workerIdx, 'transcribe', {
              audio: chunk.data.buffer,
              options: {
                return_timestamps: true,
                forceLanguage: options.forceLanguage || null,
                prompt: options.prompt || null,
              },
            }, [chunk.data.buffer], 480000);
            completedChunks++;
            if (onProgress) {
              const pct = Math.round((completedChunks / totalChunks) * 100);
              onProgress(pct, `Segment ${completedChunks}/${totalChunks}`);
            }
            results.push({ ...res, chunkId: chunk.id, chunkOffset: chunk.offsetSec, chunkDuration: chunk.durSec });
          } catch (err) {
            console.warn(`[Whisper] Chunk ${chunk.id}: worker ${workerIdx} failed:`, err.message);
            completedChunks++;
            if (onProgress) {
              const pct = Math.round((completedChunks / totalChunks) * 100);
              onProgress(pct, `Segment ${completedChunks}/${totalChunks} (failed)`);
            }
          }
        });
      }
      return chainPromise.then(() => results);
    });

    const nestedResults = await Promise.all(workerPromises);
    const results = nestedResults.flat();

    // Sort by chunk id
    results.sort((a, b) => a.chunkId - b.chunkId);

    // Flatten into segments
    const segments = [];
    for (const res of results) {
      const detectedLang = res.detectedLanguage || options.forceLanguage || 'en';
      const rawChunks = res.chunks || [];
      if (rawChunks.length > 0) {
        for (const c of rawChunks) {
          if (!c.text || !c.text.trim()) continue;
          const [ts, te] = c.timestamp || [0, res.chunkDuration];
          segments.push({
            start: res.chunkOffset + ts,
            end: res.chunkOffset + (te || ts + 2),
            text: c.text.trim(),
            detectedLanguage: detectedLang,
          });
        }
      } else if (res.text && res.text.trim()) {
        segments.push({
          start: res.chunkOffset,
          end: res.chunkOffset + res.chunkDuration,
          text: res.text.trim(),
          detectedLanguage: detectedLang,
        });
      }
    }

    return segments;
  }

  async transcribe(audioFloat32Array, options = {}) {
    if (this._usingWorker && this._workers.length > 0) {
      return this._transcribeViaWorker(audioFloat32Array, options);
    }
    if (!this._fallback) throw new Error('Not loaded');
    return this._fallback.transcribe(audioFloat32Array, options);
  }

  async _transcribeViaWorker(audioFloat32Array, options = {}) {
    let input = audioFloat32Array;
    if (!(input instanceof Float32Array)) {
      if (input && input.array instanceof Float32Array) input = input.array;
      else if (ArrayBuffer.isView(input)) input = new Float32Array(input.buffer, input.byteOffset, input.length);
      else if (Array.isArray(input)) input = Float32Array.from(input);
    }

    return this._sendTo(0, 'transcribe', {
      audio: input.buffer,
      options: {
        return_timestamps: options.returnTimestamps,
        chunk_length_s: options.chunkLength,
        stride_length_s: options.strideLength,
        forceLanguage: options.forceLanguage,
        language: options.language,
        prompt: options.prompt || null,
      },
    }, [input.buffer]);
  }

  async transcribeChunked(audioFloat32Array, options = {}) {
    if (this._usingWorker && this._workers.length > 0) {
      const result = await this.transcribe(audioFloat32Array, { ...options, returnTimestamps: true });
      return [{
        index: 0,
        text: result.text,
        chunks: result.chunks || [],
        detectedLanguage: result.detectedLanguage,
        offset: 0,
      }];
    }
    if (!this._fallback) throw new Error('Not loaded');
    return this._fallback.transcribeChunked(audioFloat32Array, options);
  }

  isReady() { return this._ready; }

  getModelType() { return this._modelType; }

  async unload() {
    this._terminateWorkers();
    if (this._fallback) {
      await this._fallback.unload();
    }
    this._ready = false;
    this._modelType = null;
    this._usingWorker = false;
  }

  _terminateWorkers() {
    for (const w of this._workers) {
      w.terminate();
    }
    this._workers = [];
    this._pending.clear();
    this._usingWorker = false;
    this._ready = false;
  }
}

export const whisper = new WhisperWorkerEngine();
export { WhisperEngine, MODEL_REPO, MODEL_VERSION };

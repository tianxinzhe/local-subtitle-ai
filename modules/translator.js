import { get, set } from './config.js';
import { env } from '@huggingface/transformers';

const HF_MIRROR = 'https://hf-mirror.com';
const MODEL_ID = 'Xenova/m2m100_418M';

class TranslationWorkerPool {
  constructor() {
    this._workers = [];
    this._pending = new Map();
    this._msgId = 0;
    this._ready = false;
  }

  async init(onProgress) {
    const numWorkers = this._workerCount();
    console.log(`[Translator] Starting translation worker pool: ${numWorkers} workers`);
    const workerUrl = chrome.runtime.getURL('modules/translate-worker.js');
    const wasmPaths = chrome.runtime.getURL('libs/');

    onProgress(5, `Starting ${numWorkers} worker(s)`);

    this._workers = [];
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(workerUrl, { type: 'module' });
      this._setupWorker(worker, i);
      this._workers.push(worker);
    }

    // Set mirror for main-thread transformers.js (for any fallback imports)
    env.remoteHost = HF_MIRROR;

    // Load model on first worker (downloads + loads)
    onProgress(10, 'Loading model (worker 1)');
    await this._sendTo(0, 'load', { wasmPaths, modelId: MODEL_ID, remoteHost: HF_MIRROR }, 300000);

    // Remaining workers load from cache
    for (let i = 1; i < this._workers.length; i++) {
      onProgress(10 + Math.round(i / numWorkers * 80), `Loading model (worker ${i + 1})`);
      await this._sendTo(i, 'load', { wasmPaths, modelId: MODEL_ID, remoteHost: HF_MIRROR }, 300000);
    }

    this._ready = true;
    onProgress(100, 'ready');
  }

  _workerCount() {
    const cpuCores = navigator.hardwareConcurrency || 4;
    return Math.min(Math.max(cpuCores - 1, 1), 3);
  }

  _setupWorker(worker, idx) {
    worker.addEventListener('message', (e) => {
      const { msgId, type, payload } = e.data;
      const pending = this._pending.get(msgId);
      if (!pending) return;

      if (type === 'loadProgress') {
        // Forward progress from first worker
        return;
      }

      this._pending.delete(msgId);
      if (type === 'loaded') {
        pending.resolve();
      } else if (type === 'translateResult') {
        pending.resolve(payload);
      } else if (type === 'error') {
        pending.reject(new Error(payload.message));
      }
    });

    worker.onerror = (err) => {
      console.error(`[Translator] Worker ${idx} error:`, err);
      for (const [msgId, pending] of this._pending) {
        if (pending.workerIdx === idx) {
          this._pending.delete(msgId);
          pending.reject(new Error('Worker crashed'));
        }
      }
    };
  }

  _sendTo(workerIdx, type, payload, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const msgId = ++this._msgId;
      this._pending.set(msgId, { resolve, reject, workerIdx });

      const timer = setTimeout(() => {
        if (this._pending.has(msgId)) {
          this._pending.delete(msgId);
          reject(new Error(`Timeout (${timeoutMs}ms) for msg ${msgId} to worker ${workerIdx}`));
        }
      }, timeoutMs);

      const origResolve = resolve;
      this._pending.set(msgId, {
        resolve: (val) => { clearTimeout(timer); origResolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        workerIdx,
      });

      this._workers[workerIdx].postMessage({ msgId, type, payload });
    });
  }

  async translate(text, srcLang, tgtLang) {
    return this._sendTo(0, 'translate', { text, srcLang, tgtLang }, 120000);
  }

  async batchTranslate(segments, srcLang, tgtLang, onProgress) {
    const SEP = '\n【=SEP=】\n';
    const MAX_BATCH_CHARS = 5000;
    const MAX_BATCH_SEGMENTS = 100;
    const total = segments.length;
    const numWorkers = this._workers.length;
    const allBatches = [];

    // Build batches
    let i = 0;
    while (i < total) {
      const batch = [];
      let charCount = 0;
      while (i < total && charCount < MAX_BATCH_CHARS && batch.length < MAX_BATCH_SEGMENTS) {
        const seg = segments[i];
        batch.push(seg);
        charCount += seg.original.length;
        i++;
      }
      allBatches.push(batch);
    }

    // Assign batches to workers round-robin
    const workerChains = Array.from({ length: numWorkers }, () => ({ batches: [], results: [] }));
    allBatches.forEach((batch, idx) => {
      workerChains[idx % numWorkers].batches.push(batch);
    });

    const workerPromises = workerChains.map((chain, workerIdx) => {
      let chainPromise = Promise.resolve();
      for (const batch of chain.batches) {
        chainPromise = chainPromise.then(async () => {
          const texts = batch.map(s => s.original);
          const combined = texts.join(SEP);
          try {
            const res = await this._sendTo(workerIdx, 'translate', {
              text: combined, srcLang, tgtLang,
            }, 120000);
            const parts = res.text.split(SEP);
            for (let j = 0; j < batch.length; j++) {
              chain.results.push({
                ...batch[j],
                translation: parts[j] ? parts[j].trim() : '',
              });
            }
          } catch {
            for (const seg of batch) {
              chain.results.push({ ...seg, translation: '' });
            }
          }
          if (onProgress) {
            const done = workerChains.reduce((s, c) => s + c.results.length, 0);
            onProgress(Math.min(100, Math.round(done / total * 100)));
          }
        });
      }
      return chainPromise;
    });

    await Promise.all(workerPromises);

    // Flatten in original order
    const results = [];
    for (const chain of workerChains) {
      for (const r of chain.results) {
        results.push(r);
      }
    }
    results.sort((a, b) => a.index - b.index);
    return results;
  }

  isReady() { return this._ready; }
  unload() {
    for (const w of this._workers) w.terminate();
    this._workers = [];
    this._ready = false;
  }
}

class GeminiEngine {
  async _checkAvailable() {
    try {
      // Chrome 138+: window.Translator (new API)
      if (typeof Translator !== 'undefined' && Translator.canTranslate) {
        return true;
      }
      // Chrome 131-137: window.ai.translator (old API)
      const ai = typeof window !== 'undefined' ? window.ai : (typeof self !== 'undefined' ? self.ai : null);
      if (ai && ai.translator) {
        const caps = await ai.translator.capabilities();
        return caps && caps.available !== 'no';
      }
      return false;
    } catch { return false; }
  }

  async _canTranslate(source, target) {
    try {
      // Chrome 138+: window.Translator
      if (typeof Translator !== 'undefined' && Translator.canTranslate) {
        const r = await Translator.canTranslate({ sourceLanguage: source, targetLanguage: target });
        return r === 'readily' || r === 'after-download';
      }
      // Chrome 131-137: window.ai.translator
      const ai = typeof window !== 'undefined' ? window.ai : (typeof self !== 'undefined' ? self.ai : null);
      if (!ai || !ai.translator) return false;
      const caps = await ai.translator.capabilities();
      if (!caps || !caps.canTranslate) return false;
      const r = await caps.canTranslate({ sourceLanguage: source, targetLanguage: target });
      return r === 'readily' || r === 'after-download';
    } catch { return false; }
  }

  async translate(text, sourceLang, targetLang) {
    // Chrome 138+: window.Translator
    if (typeof Translator !== 'undefined' && Translator.create) {
      const t = await Translator.create({
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
      });
      return t.translate(text);
    }
    // Chrome 131-137: window.ai.translator
    const t = await window.ai.translator.create({
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
    });
    return t.translate(text);
  }
}

class Translator {
  constructor() {
    this._gemini = new GeminiEngine();
    this._workerPool = null;
    this._engine = null;
    this._ready = false;
  }

  async init(options = {}) {
    const onProgress = options.onProgress || (() => {});
    this._ready = false;

    onProgress(0, 'checking');
    const geminiOk = await this._gemini._checkAvailable();

    if (geminiOk) {
      this._engine = 'gemini-nano';
      this._ready = true;
      console.log('[Translator] Using engine: Gemini Nano');
      onProgress(100, 'gemini_ready');
      return;
    }

    onProgress(5, 'setting_up_workers');
    env.remoteHost = HF_MIRROR;

    this._workerPool = new TranslationWorkerPool();
    try {
      await this._workerPool.init(onProgress);
      this._engine = 'nllb';
      this._ready = true;
      const workerCount = this._workerPool._workers.length;
      console.log(`[Translator] Using engine: M2M100-418M (${workerCount} workers)`);
      onProgress(100, `nllb_${workerCount}workers`);
      await set('nllbModelDownloaded', true);
    } catch (err) {
      console.error('[Translator] Worker pool init failed:', err);
      this._ready = false;
      throw new Error(`Translation engine unavailable: ${err.message}`);
    }
  }

  async translate(text, sourceLang, targetLang, context = []) {
    if (!this._ready) return text;
    if (!text || !text.trim()) return '';
    if (sourceLang === targetLang) return text;

    try {
      if (this._engine === 'gemini-nano') {
        const ok = await this._gemini._canTranslate(sourceLang, targetLang);
        if (ok) return this._gemini.translate(text, sourceLang, targetLang);
        console.warn('[Translator] Gemini cannot translate this pair');
        return text;
      }
      return this._workerPool.translate(text, sourceLang, targetLang);
    } catch (err) {
      console.warn('[Translator] translate failed:', err.message);
      return text;
    }
  }

  async batchTranslate(segments, sourceLang, targetLang, onProgress) {
    if (!this._ready) return segments.map(s => ({ ...s, translation: '' }));
    if (sourceLang === targetLang) {
      console.log(`[Translator] Source == target (${sourceLang}), skipping translation`);
      return segments.map(s => ({ ...s, translation: '' }));
    }

    console.log(`[Translator] batchTranslate: ${segments.length} segs, ${sourceLang}→${targetLang}, engine=${this._engine}`);

    try {
      if (this._engine === 'gemini-nano') {
        const ok = await this._gemini._canTranslate(sourceLang, targetLang);
        if (ok) {
          // Gemini: process sequentially (no worker pool)
          const results = [];
          for (let i = 0; i < segments.length; i++) {
            const t = await this._gemini.translate(segments[i].original, sourceLang, targetLang);
            results.push({ ...segments[i], translation: t || '' });
            if (onProgress) onProgress(Math.round((i + 1) / segments.length * 100));
          }
          return results;
        }
        return segments.map(s => ({ ...s, translation: '' }));
      }
      return this._workerPool.batchTranslate(segments, sourceLang, targetLang, onProgress);
    } catch (err) {
      console.warn('[Translator] batchTranslate failed:', err.message);
      return segments.map(s => ({ ...s, translation: '' }));
    }
  }

  getEngine() { return this._engine; }
  isReady() { return this._ready; }
}

export const translator = new Translator();

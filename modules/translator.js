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
    this._onProgress = onProgress;
    this._numWorkers = this._workerCount();
    console.log(`[Translator] Starting translation worker pool: ${this._numWorkers} workers`);
    this._engineInfo = null;
    this._errorDetail = '';
    this._lastProgressTime = 0;
    const workerUrl = chrome.runtime.getURL('modules/translate-worker.js');
    const wasmPaths = chrome.runtime.getURL('libs/');

    this._workers = [];
    for (let i = 0; i < this._numWorkers; i++) {
      const worker = new Worker(workerUrl, { type: 'module' });
      this._setupWorker(worker, i);
      this._workers.push(worker);
    }

    env.remoteHost = HF_MIRROR;

    // Load model on first worker (downloads + loads)
    onProgress(10, 'Downloading M2M100-418M...');
    const result = await this._sendTo(0, 'load', { wasmPaths, modelId: MODEL_ID, remoteHost: HF_MIRROR }, 300000);
    if (!result || !result.success) {
      const errMsg = result?.error || 'Unknown error';
      this._errorDetail = `Graph optimization: ${errMsg}`;
      this._ready = false;
      throw new Error(`M2M100-418M failed to load: ${errMsg}`);
    }

    this._engineInfo = { dtype: result.dtype, optLevel: result.optLevel };

    // Remaining workers load from cache
    for (let i = 1; i < this._workers.length; i++) {
      const pct = this._workerLoadPct(i);
      onProgress(pct, `Loading cache (worker ${i + 1})...`);
      await this._sendTo(i, 'load', { wasmPaths, modelId: MODEL_ID, remoteHost: HF_MIRROR }, 300000);
    }

    this._ready = true;
    const workerCount = this._workers.length;
    onProgress(100, `M2M100-418M ready (${workerCount} workers)`);
  }

  _workerLoadPct(workerIdx) {
    if (this._numWorkers <= 1) return 95;
    return 10 + Math.round(workerIdx / (this._numWorkers - 1) * 85);
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
        if (this._onProgress && payload && typeof payload.progress === 'number') {
          const pct = payload.progress <= 1 ? payload.progress * 100 : payload.progress;
          const wi = pending.workerIdx;
          let overall;
          if (this._numWorkers <= 1) {
            overall = 10 + Math.round(pct / 100 * 85);
          } else {
            const start = this._workerLoadPct(wi);
            const end = wi + 1 < this._numWorkers ? this._workerLoadPct(wi + 1) : 95;
            overall = start + Math.round(pct / 100 * (end - start));
          }
          // Throttle UI updates to every 300ms to avoid flickering
          const now = Date.now();
          if (!this._lastProgressTime || now - this._lastProgressTime > 300) {
            this._lastProgressTime = now;
            const stage = wi === 0 ? 'Downloading model' : `Loading cache (worker ${wi + 1})`;
            this._onProgress(overall, stage);
          }
        }
        return;
      }

      this._pending.delete(msgId);
      if (type === 'loaded') {
        pending.resolve(payload);
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
    const res = await this._sendTo(0, 'translate', { texts: [text], srcLang, tgtLang }, 180000);
    return res.translations?.[0] || text;
  }

  async batchTranslate(segments, srcLang, tgtLang, onProgress) {
    // With batched pipe() call, inference is ~10-20s per 20 texts
    // Increase batch size to reduce total Worker recreation overhead
    const MAX_BATCH_CHARS = 1500;
    const MAX_BATCH_SEGMENTS = 20;
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
    console.log(`[batchTranslate] ${total} segs → ${allBatches.length} batches, ${numWorkers} workers`);
    const workerChains = Array.from({ length: numWorkers }, () => ({ batches: [], results: [], callsSinceRecreate: 0 }));
    allBatches.forEach((batch, idx) => {
      workerChains[idx % numWorkers].batches.push(batch);
    });

    const workerUrl = chrome.runtime.getURL('modules/translate-worker.js');
    const wasmPaths = chrome.runtime.getURL('libs/');

    const workerPromises = workerChains.map((chain, workerIdx) => {
      let chainPromise = Promise.resolve();
      for (const batch of chain.batches) {
        chainPromise = chainPromise.then(async () => {
          // Recreate worker every 80 pipe() calls to avoid ORT WASM deadlock (~100 threshold)
          if (chain.callsSinceRecreate >= 80) {
            if (this._workers[workerIdx]) {
              this._workers[workerIdx].terminate();
              const freshWorker = new Worker(workerUrl, { type: 'module' });
              this._setupWorker(freshWorker, workerIdx);
              this._workers[workerIdx] = freshWorker;
              await this._sendTo(workerIdx, 'load', { wasmPaths, modelId: MODEL_ID, remoteHost: HF_MIRROR }, 120000);
            }
            chain.callsSinceRecreate = 0;
          }

          const texts = batch.map(s => s.original);
          try {
            const res = await this._sendTo(workerIdx, 'translate', {
              texts, srcLang, tgtLang,
            }, 180000);
            if (!res.translations || res.translations.length !== batch.length) {
              console.error(`[batchTranslate] w${workerIdx} expected ${batch.length} translations, got ${res.translations?.length}`);
              throw new Error('Translation count mismatch');
            }
            chain.callsSinceRecreate += batch.length;
            console.log(`[batchTranslate] w${workerIdx} batch=${batch.length} ok, calls=${chain.callsSinceRecreate}, non-empty=${res.translations.filter(t => t.length > 0).length}`);
            for (let j = 0; j < batch.length; j++) {
              chain.results.push({
                ...batch[j],
                translation: res.translations[j] || '',
              });
            }
          } catch (err) {
            console.error(`[batchTranslate] w${workerIdx} batch failed:`, err?.message || err);
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
      // Chrome 138+: window.Translator (stable)
      if (typeof Translator !== 'undefined') {
        if (typeof Translator.availability === 'function') {
          const status = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
          return status !== 'no';
        }
        return true;
      }
      // Chrome 131-137: window.ai.translator (experimental)
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
      if (typeof Translator !== 'undefined') {
        if (typeof Translator.availability === 'function') {
          const status = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
          return status === 'readily' || status === 'after-download';
        }
        return true;
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
    this._lastError = '';
  }

  async init(options = {}) {
    const onProgress = options.onProgress || (() => {});
    this._ready = false;

    onProgress(0, 'Checking translation engine...');
    const geminiOk = await this._gemini._checkAvailable();

    if (geminiOk) {
      this._engine = 'gemini-nano';
      this._ready = true;
      console.log('[Translator] Using engine: Gemini Nano');
      onProgress(100, 'Gemini Nano ready');
      return;
    }

    onProgress(5, 'Setting up workers...');
    env.remoteHost = HF_MIRROR;

    this._workerPool = new TranslationWorkerPool();
    try {
      await this._workerPool.init(onProgress);
      this._engine = 'nllb';
      this._ready = true;
      const workerCount = this._workerPool._workers.length;
      console.log(`[Translator] Using engine: M2M100-418M (${workerCount} workers)`);
      onProgress(100, `M2M100-418M ready (${workerCount} workers)`);
      await set('nllbModelDownloaded', true);
    } catch (err) {
      console.error('[Translator] Worker pool init failed:', err);
      this._ready = false;
      this._lastError = err.message;
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

  getEngineDetail() {
    if (this._engine === 'gemini-nano') {
      return { engine: 'Chrome Translator (Gemini Nano)', available: true, detail: '' };
    }
    if (this._engine === 'nllb' && this._workerPool && this._workerPool._engineInfo) {
      const info = this._workerPool._engineInfo;
      const dt = info?.dtype || '?';
      const opt = info?.optLevel || '?';
      return { engine: `M2M100-418M (${this._workerPool._workers.length} workers)`, available: true, detail: `${dt}, graph opt: ${opt}` };
    }
    if (this._lastError) {
      return { engine: 'M2M100-418M (on-device)', available: false, detail: this._lastError };
    }
    return null;
  }

  static async getEnginesStatus() {
    const results = [];
    // Chrome Translator API
    try {
      let available = false;
      let detail = '';
      if (typeof Translator !== 'undefined') {
        try {
          if (typeof Translator.availability === 'function') {
            const r = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
            if (r === 'readily') { available = true; detail = 'Ready'; }
            else if (r === 'after-download') { available = true; detail = 'Model will download on first use'; }
            else { detail = 'Not available for this language pair'; }
          } else {
            available = true;
            detail = 'Available';
          }
        } catch (e) {
          detail = `Error: ${e.message}`;
        }
        const caps = await ai.translator.capabilities();
        if (caps.available !== 'no') { available = true; detail = 'Ready'; }
        else { detail = 'Gemini Nano not downloaded. Enable chrome://flags/#optimization-guide-on-device-model'; }
      } else {
        detail = 'Not supported in this Chrome version (need 131+)';
      }
      results.push({ engine: 'Chrome Translator (Gemini Nano)', available, detail });
    } catch (e) {
      results.push({ engine: 'Chrome Translator (Gemini Nano)', available: false, detail: `Error: ${e.message}` });
    }
    // M2M100-418M
    try {
      if (typeof Worker === 'undefined') {
        results.push({ engine: 'M2M100-418M (on-device)', available: false, detail: 'Web Workers not supported' });
      } else {
        results.push({ engine: 'M2M100-418M (on-device)', available: true, detail: 'Will download ~800MB on first use' });
      }
    } catch (e) {
      results.push({ engine: 'M2M100-418M (on-device)', available: false, detail: `Error: ${e.message}` });
    }
    return results;
  }
}

export const translator = new Translator();
export { Translator };

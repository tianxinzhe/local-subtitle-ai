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
    return Math.min(Math.max(cpuCores - 1, 1), 4);
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

      console.log(`[_sendTo] worker=${workerIdx} type=${type} msgId=${msgId} timeout=${timeoutMs}ms`);
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

    // Recreate ALL workers before batch processing to avoid WASM deadlock from prior state
    console.log(`[batchTranslate] Recreating ${numWorkers} workers for fresh state`);
    for (let wi = 0; wi < numWorkers; wi++) {
      if (this._workers[wi]) this._workers[wi].terminate();
      const freshWorker = new Worker(workerUrl, { type: 'module' });
      this._setupWorker(freshWorker, wi);
      this._workers[wi] = freshWorker;
    }
    // Load model on all workers sequentially
    for (let wi = 0; wi < numWorkers; wi++) {
      await this._sendTo(wi, 'load', { wasmPaths, modelId: MODEL_ID, remoteHost: HF_MIRROR }, 120000);
      console.log(`[batchTranslate] w${wi} model reloaded`);
    }

    const workerPromises = workerChains.map((chain, workerIdx) => {
      console.log(`[batchTranslate] w${workerIdx}: ${chain.batches.length} batches total`);
      let chainPromise = Promise.resolve();
      chain.batches.forEach((batch, bi) => {
        chainPromise = chainPromise.then(async () => {
          console.log(`[batchTranslate] w${workerIdx} starting batch ${bi} (${batch.length} segs)`);
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
          let retries = 0;
          const MAX_RETRIES = 1;
          while (retries <= MAX_RETRIES) {
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
              break;
            } catch (err) {
              retries++;
              if (retries <= MAX_RETRIES) {
                console.warn(`[batchTranslate] w${workerIdx} batch failed (retry ${retries}/${MAX_RETRIES}):`, err?.message || err);
                // Recreate worker and reload model before retry
                try {
                  this._workers[workerIdx].terminate();
                  const freshWorker = new Worker(workerUrl, { type: 'module' });
                  this._setupWorker(freshWorker, workerIdx);
                  this._workers[workerIdx] = freshWorker;
                  await this._sendTo(workerIdx, 'load', { wasmPaths, modelId: MODEL_ID, remoteHost: HF_MIRROR }, 120000);
                  chain.callsSinceRecreate = 0;
                } catch (loadErr) {
                  console.error(`[batchTranslate] w${workerIdx} reload failed:`, loadErr?.message);
                  break;
                }
              } else {
                console.error(`[batchTranslate] w${workerIdx} batch failed after ${MAX_RETRIES} retries:`, err?.message || err);
                for (const seg of batch) {
                  chain.results.push({ ...seg, translation: '' });
                }
              }
            }
          }
          if (onProgress) {
            const done = workerChains.reduce((s, c) => s + c.results.length, 0);
            onProgress(Math.min(100, Math.round(done / total * 100)));
          }
        });
      });
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
  constructor() {
    this._translator = null;
    this._ready = false;
    this._lastError = '';
  }

  _getAI() {
    // 扩展 sidepanel / service worker / popup 都能用 self.ai
    const ai = (typeof self !== 'undefined' && self.ai) 
            || (typeof window !== 'undefined' && window.ai);
    return ai;
  }

  async _checkAvailable() {
    // 诊断：打印所有相关全局对象
    console.log('[Gemini] === Built-in AI 诊断 ===');
    console.log('[Gemini] typeof self.ai:', typeof (typeof self !== 'undefined' ? self.ai : undefined));
    console.log('[Gemini] typeof window.ai:', typeof (typeof window !== 'undefined' ? window.ai : undefined));
    console.log('[Gemini] typeof Translator:', typeof (typeof self !== 'undefined' ? self.Translator : undefined));
    console.log('[Gemini] typeof LanguageModel:', typeof (typeof self !== 'undefined' ? self.LanguageModel : undefined));
    
    const ai = this._getAI();
    if (ai) {
      console.log('[Gemini] self.ai 存在, keys:', Object.keys(ai));
    } else {
      console.log('[Gemini] ✗ self.ai 不存在');
      console.log('[Gemini] 提示: 需要在 chrome://flags/ 启用 #prompt-api-for-gemini-nano');
    }

    // 路径 1: self.ai.translator (Chrome 131-138+ 标准路径)
    if (ai && ai.translator) {
      console.log('[Gemini] ✓ 找到 self.ai.translator');
      try {
        const caps = await ai.translator.capabilities();
        console.log('[Gemini] capabilities:', JSON.stringify(caps));
        if (caps.available === 'readily' || caps.available === 'after-download') {
          this._ready = true;
          this._lastError = '';
          console.log('[Gemini] ✓ self.ai.translator 可用');
          return true;
        }
        if (caps.available === 'downloadable') {
          console.log('[Gemini] → 模型可下载,准备创建触发下载');
          this._ready = true;
          return true;
        }
        this._lastError = `self.ai.translator unavailable: ${caps.available}`;
        console.log('[Gemini] ✗ self.ai.translator 不可用:', caps.available);
      } catch (e) {
        console.warn('[Gemini] self.ai.translator.capabilities() 失败:', e.message);
        this._lastError = e.message;
      }
    }

    // 路径 2: window.Translator (Chrome 138+ 实验性)
    const T = (typeof self !== 'undefined' && self.Translator) 
           || (typeof window !== 'undefined' && window.Translator);
    if (T && typeof T.create === 'function') {
      console.log('[Gemini] 找到 window.Translator,尝试 create()...');
      try {
        this._translator = await T.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
        this._ready = true;
        this._lastError = '';
        console.log('[Gemini] ✓ window.Translator.create() 成功');
        return true;
      } catch (e) {
        console.warn('[Gemini] window.Translator.create() 失败:', e.message);
        this._lastError = e.message;
      }
    }

    console.log('[Gemini] ✗ 所有翻译 API 路径都失败');
    console.log('[Gemini] 请检查:');
    console.log('[Gemini]   1. chrome://flags/#prompt-api-for-gemini-nano = Enabled');
    console.log('[Gemini]   2. chrome://components/ → Optimization Guide On Device Model 已下载');
    return false;
  }

  async _canTranslate(source, target) {
    try {
      const ai = this._getAI();
      // 路径 1: self.ai.translator
      if (ai && ai.translator) {
        if (this._translator) return true;
        try {
          this._translator = await ai.translator.create({ sourceLanguage: source, targetLanguage: target });
          return true;
        } catch (e) {
          console.warn('[Gemini] self.ai.translator.create 失败:', e.message);
          return false;
        }
      }
      // 路径 2: window.Translator
      const T = (typeof self !== 'undefined' && self.Translator) 
             || (typeof window !== 'undefined' && window.Translator);
      if (T && typeof T.create === 'function') {
        if (this._translator) return true;
        try {
          this._translator = await T.create({ sourceLanguage: source, targetLanguage: target });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    } catch { return false; }
  }

  async translate(text, sourceLang, targetLang) {
    // 复用已创建的实例
    if (this._translator) {
      return this._translator.translate(text);
    }

    // 路径 1: self.ai.translator
    const ai = this._getAI();
    if (ai && ai.translator) {
      console.log('[Gemini] 创建 self.ai.translator 实例...');
      this._translator = await ai.translator.create({
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
      });
      return this._translator.translate(text);
    }

    // 路径 2: window.Translator
    const T = (typeof self !== 'undefined' && self.Translator) 
           || (typeof window !== 'undefined' && window.Translator);
    if (T && typeof T.create === 'function') {
      console.log('[Gemini] 创建 window.Translator 实例...');
      this._translator = await T.create({
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
      });
      return this._translator.translate(text);
    }

    throw new Error('Translation API not available');
  }
}

class Translator {
  constructor() {
    this._gemini = new GeminiEngine();
    this._workerPool = null;
    this._engine = null;
    this._ready = false;
    this._lastError = '';
    this._enginePreference = 'auto';
  }

  async init(options = {}) {
    const onProgress = options.onProgress || (() => {});
    const enginePreference = options.enginePreference || 'auto';
    this._enginePreference = enginePreference;
    this._ready = false;

    if (enginePreference === 'gemini-nano' || enginePreference === 'auto') {
      onProgress(0, 'Checking translation engine...');
      const geminiOk = await this._gemini._checkAvailable();

      if (geminiOk) {
        this._engine = 'gemini-nano';
        this._ready = true;
        console.log('[Translator] Using engine: Gemini Nano');
        onProgress(100, 'Gemini Nano ready');
        return;
      }

      if (enginePreference === 'gemini-nano') {
        this._ready = false;
        this._lastError = 'Gemini Nano not available';
        throw new Error('Gemini Nano not available');
      }
    }

    if (enginePreference === 'm2m100' || enginePreference === 'auto') {
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
  }

  async translate(text, sourceLang, targetLang, context = []) {
    if (!this._ready) return text;
    if (!text || !text.trim()) return '';
    if (sourceLang === targetLang) return text;

    try {
      if (this._engine === 'gemini-nano') {
        const ok = await this._gemini._canTranslate(sourceLang, targetLang);
        if (ok) return this._gemini.translate(text, sourceLang, targetLang);
        if (this._enginePreference === 'auto') {
          console.warn(`[Translator] Gemini Nano doesn't support ${sourceLang}→${targetLang}, falling back to M2M100`);
          if (!this._workerPool || !this._workerPool.isReady()) {
            this._workerPool = new TranslationWorkerPool();
            await this._workerPool.init(() => {});
          }
          return this._workerPool.translate(text, sourceLang, targetLang);
        }
        console.warn(`[Translator] Gemini Nano doesn't support ${sourceLang}→${targetLang}`);
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
        console.log(`[Translator] Gemini _canTranslate(${sourceLang}→${targetLang}) = ${ok}`);
        if (ok) {
          const results = [];
          for (let i = 0; i < segments.length; i++) {
            try {
              const t = await this._gemini.translate(segments[i].original, sourceLang, targetLang);
              results.push({ ...segments[i], translation: t || '' });
            } catch (e) {
              console.warn(`[Translator] Gemini translate #${i} failed:`, e.message);
              results.push({ ...segments[i], translation: '' });
            }
            if (onProgress) onProgress(Math.round((i + 1) / segments.length * 100));
          }
          const nonEmpty = results.filter(r => r.translation).length;
          console.log(`[Translator] Gemini done: ${nonEmpty}/${results.length} translated`);
          return results;
        }
        // Gemini Nano doesn't support this pair — fall back to M2M100 only in 'auto' mode
        if (this._enginePreference === 'auto') {
          console.warn(`[Translator] Gemini Nano doesn't support ${sourceLang}→${targetLang}, falling back to M2M100`);
          if (!this._workerPool || !this._workerPool.isReady()) {
            if (onProgress) onProgress(0, 'Loading M2M100-418M fallback...');
            this._workerPool = new TranslationWorkerPool();
            await this._workerPool.init(onProgress);
          }
          return this._workerPool.batchTranslate(segments, sourceLang, targetLang, onProgress);
        }
        console.warn(`[Translator] Gemini Nano doesn't support ${sourceLang}→${targetLang}, returning empty`);
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

  async unload() {
    if (this._gemini) {
      this._gemini._translator = null;
      this._gemini._ready = false;
    }
    if (this._workerPool) {
      this._workerPool.unload();
      this._workerPool = null;
    }
    this._engine = null;
    this._ready = false;
    this._lastError = '';
  }

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
      let flagNeeded = false;
      const ai = (typeof self !== 'undefined' && self.ai) 
              || (typeof window !== 'undefined' && window.ai);
      
      // 路径 1: self.ai.translator (Chrome 131-138+ 标准)
      if (ai && ai.translator) {
        try {
          const caps = await ai.translator.capabilities();
          if (caps.available === 'readily') {
            available = true; detail = 'Ready';
          } else if (caps.available === 'after-download') {
            available = true; detail = 'Model will download on first use';
          } else if (caps.available === 'downloadable') {
            available = true; detail = 'Model downloading...';
          } else {
            detail = `Status: ${caps.available}`;
          }
        } catch (e) {
          detail = `Error: ${e.message}`;
        }
      }
      // 路径 2: window.Translator (Chrome 138+ 实验性)
      else if (typeof Translator !== 'undefined') {
        if (typeof Translator.availability === 'function') {
          try {
            const r = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
            if (r === 'readily') { available = true; detail = 'Ready'; }
            else if (r === 'after-download') { available = true; detail = 'Model will download on first use'; }
            else { detail = `Status: ${r}`; }
          } catch (e) {
            detail = `Error: ${e.message}`;
          }
        } else {
          detail = 'API not ready';
        }
      }
      // 两个都没有
      else {
        flagNeeded = true;
        detail = '⚠️ Enable chrome://flags/#prompt-api-for-gemini-nano';
      }
      
      results.push({ 
        engine: 'Chrome Translator (Gemini Nano)', 
        available, 
        detail,
        flagNeeded,
        flagUrl: 'chrome://flags/#prompt-api-for-gemini-nano'
      });
    } catch (e) {
      results.push({ 
        engine: 'Chrome Translator (Gemini Nano)', 
        available: false, 
        detail: `Error: ${e.message}`,
        flagNeeded: true,
        flagUrl: 'chrome://flags/#prompt-api-for-gemini-nano'
      });
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

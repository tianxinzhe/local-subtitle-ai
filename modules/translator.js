import { get, set } from './config.js';

const GEMINI_SUPPORTED_PAIRS = {
  en: ['zh', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'ar', 'hi', 'th', 'vi', 'it', 'nl', 'pl', 'tr', 'id', 'ms'],
};

class Translator {
  constructor() {
    this._engine = null;
    this._ready = false;
    this._fallbackReady = false;
    this._onnxSession = null;
    this._nllbTokenizer = null;
    this._ort = null;
  }

  async init(options = {}) {
    const onProgress = options.onProgress || (() => {});
    this._ready = false;

    onProgress(0, 'checking');

    const geminiAvailable = await this._checkGeminiNano();

    if (geminiAvailable) {
      this._engine = 'gemini-nano';
      this._ready = true;
      onProgress(100, 'gemini_ready');
      return;
    }

    onProgress(50, 'downloading_fallback');

    try {
      await this._loadOnnxFallback(onProgress);
      this._engine = 'onnx-nllb';
      this._ready = true;
      onProgress(100, 'onnx_ready');
    } catch (err) {
      console.error('[Translator] Fallback load failed:', err);
      this._ready = false;
      throw new Error(`Translation engine unavailable: ${err.message}`);
    }
  }

  async _checkGeminiNano() {
    try {
      if (typeof window !== 'undefined' && window.ai && window.ai.translator) {
        const capabilities = await window.ai.translator.capabilities();
        return capabilities && capabilities.available !== 'no';
      }
      if (typeof self !== 'undefined' && self.ai && self.ai.translator) {
        const capabilities = await self.ai.translator.capabilities();
        return capabilities && capabilities.available !== 'no';
      }
      return false;
    } catch {
      return false;
    }
  }

  async _loadOnnxFallback(onProgress) {
    onProgress(60, 'loading_onnx');

    const ortUrl = chrome.runtime.getURL(
      'libs/ort.min.js'
    );
    this._ort = await import(ortUrl);

    onProgress(70, 'loading_tokenizer');

    try {
      const tokenizerResp = await fetch(
        chrome.runtime.getURL('models/nllb_tokenizer.json')
      );
      this._nllbTokenizer = await tokenizerResp.json();
    } catch {
      console.warn('[Translator] NLLB tokenizer not found, using fallback');
    }

    onProgress(80, 'loading_model');

    try {
      this._onnxSession = await this._ort.InferenceSession.create(
        chrome.runtime.getURL('models/nllb-200-distilled-600m-int8.onnx'),
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
      );
    } catch {
      console.warn('[Translator] NLLB model not found, translation will be limited');
    }

    await set('nllbModelDownloaded', true);
    onProgress(100, 'onnx_loaded');
  }

  async _translateViaGemini(text, sourceLang, targetLang, context) {
    try {
      const translator = await window.ai.translator.create({
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
      });

      let prompt = text;
      if (context && context.length > 0) {
        prompt = `Context: ${context.join(' ')}\nTranslate: ${text}`;
      }

      const result = await translator.translate(prompt);
      return result;
    } catch (err) {
      console.error('[Translator] Gemini Nano failed:', err);
      throw err;
    }
  }

  async _translateViaOnnx(text, sourceLang, targetLang, context) {
    if (!this._onnxSession || !this._nllbTokenizer) {
      throw new Error('ONNX NLLB model not loaded');
    }

    const srcCode = this._toFloresCode(sourceLang);
    const tgtCode = this._toFloresCode(targetLang);
    const inputText = `${srcCode} >> ${tgtCode} >> ${text}`;

    const tokens = this._tokenize(inputText);
    const inputTensor = new this._ort.Tensor('int64', tokens, [1, tokens.length]);

    const feeds = { input_ids: inputTensor };
    const results = await this._onnxSession.run(feeds);
    const outputTokens = results.output_ids.data;

    const translation = this._detokenize(outputTokens);
    return translation;
  }

  _toFloresCode(langCode) {
    const map = {
      en: 'eng_Latn', zh: 'zho_Hans', ja: 'jpn_Jpan', ko: 'kor_Hang',
      fr: 'fra_Latn', de: 'deu_Latn', es: 'spa_Latn', pt: 'por_Latn',
      ru: 'rus_Cyrl', ar: 'arb_Arab', hi: 'hin_Deva', th: 'tha_Thai',
      vi: 'vie_Latn', it: 'ita_Latn', nl: 'nld_Latn', pl: 'pol_Latn',
      tr: 'tur_Latn', id: 'ind_Latn', ms: 'msa_Latn', sv: 'swe_Latn',
      da: 'dan_Latn', fi: 'fin_Latn', cs: 'ces_Latn', ro: 'ron_Latn',
      uk: 'ukr_Cyrl', el: 'ell_Grek', he: 'heb_Hebr', bn: 'ben_Beng',
      ta: 'tam_Taml', te: 'tel_Telu', mr: 'mar_Deva', ur: 'urd_Arab',
      fa: 'pes_Arab', ne: 'npi_Deva', km: 'khm_Khmr', my: 'mya_Mymr',
      lo: 'lao_Laoo', ka: 'kat_Geor', hy: 'hye_Armn', az: 'azj_Latn',
      af: 'afr_Latn', sq: 'sqi_Latn', am: 'amh_Ethi', eu: 'eus_Latn',
      be: 'bel_Cyrl', bs: 'bos_Latn', bg: 'bul_Cyrl', ca: 'cat_Latn',
      hr: 'hrv_Latn', et: 'est_Latn', gl: 'glg_Latn', is: 'isl_Latn',
      lv: 'lav_Latn', lt: 'lit_Latn', mk: 'mkd_Cyrl', mt: 'mlt_Latn',
      mn: 'mon_Cyrl', sr: 'srp_Cyrl', sk: 'slk_Latn', sl: 'slv_Latn',
      sw: 'swh_Latn', tg: 'tgk_Cyrl', uz: 'uzn_Latn', cy: 'cym_Latn',
      yi: 'yid_Hebr', zu: 'zul_Latn', jw: 'jav_Latn', su: 'sun_Latn',
      ml: 'mal_Mlym', kn: 'kan_Knda', gu: 'guj_Gujr', pa: 'pan_Guru',
      or: 'ory_Orya', as: 'asm_Beng', si: 'sin_Sinh', kk: 'kaz_Cyrl',
      ky: 'kir_Cyrl', tk: 'tuk_Latn', ps: 'pst_Arab', sd: 'snd_Arab',
      ha: 'hau_Latn', yo: 'yor_Latn', ig: 'ibo_Latn', so: 'som_Latn',
      ny: 'nya_Latn', mg: 'plt_Latn', eo: 'epo_Latn', la: 'lat_Latn',
    };
    return map[langCode] || `eng_Latn`;
  }

  _tokenize(text) {
    if (this._nllbTokenizer && this._nllbTokenizer.encode) {
      return this._nllbTokenizer.encode(text);
    }
    const tokens = [];
    for (let i = 0; i < Math.min(text.length, 512); i++) {
      tokens.push(text.charCodeAt(i));
    }
    return tokens;
  }

  _detokenize(tokens) {
    if (this._nllbTokenizer && this._nllbTokenizer.decode) {
      return this._nllbTokenizer.decode(tokens);
    }
    return String.fromCharCode(...tokens.filter(t => t > 0 && t < 0xFFFF));
  }

  async translate(text, sourceLang, targetLang, context = []) {
    if (!this._ready) {
      console.warn('[Translator] Engine not ready, returning original text');
      return text;
    }

    if (!text || text.trim().length === 0) {
      return '';
    }

    if (sourceLang === targetLang) {
      return text;
    }

    try {
      if (this._engine === 'gemini-nano') {
        const supported = GEMINI_SUPPORTED_PAIRS[sourceLang];
        if (supported && supported.includes(targetLang)) {
          return await this._translateViaGemini(text, sourceLang, targetLang, context);
        }
        // Gemini doesn't support this language pair, try ONNX
        if (this._onnxSession && this._nllbTokenizer) {
          return await this._translateViaOnnx(text, sourceLang, targetLang, context);
        }
        console.warn('[Translator] No engine supports this language pair, returning original');
        return text;
      }
      if (this._onnxSession && this._nllbTokenizer) {
        return await this._translateViaOnnx(text, sourceLang, targetLang, context);
      }
      console.warn('[Translator] ONNX model not loaded, returning original text');
      return text;
    } catch (err) {
      console.warn('[Translator] translate failed, returning original:', err.message);
      return text;
    }
  }

  async batchTranslate(segments, sourceLang, targetLang, contextBuilder) {
    const results = [];
    const context = [];

    for (const seg of segments) {
      let ctx = [];
      if (contextBuilder) {
        ctx = contextBuilder(context);
      }

      const translation = await this.translate(
        seg.text,
        sourceLang,
        targetLang,
        ctx
      );

      results.push({
        ...seg,
        translation,
      });

      context.push({ original: seg.text, translation });
      if (context.length > 3) {
        context.shift();
      }
    }

    return results;
  }

  getEngine() {
    return this._engine;
  }

  isReady() {
    return this._ready;
  }
}

export const translator = new Translator();
export { GEMINI_SUPPORTED_PAIRS };

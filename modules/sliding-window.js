class SlidingWindow {
  constructor(size = 3) {
    this._size = size;
    this._buffer = [];
    this._sourceLanguage = 'en';
    this._targetLanguage = 'zh';
  }

  setSize(size) {
    this._size = Math.max(1, size);
  }

  setLanguages(source, target) {
    this._sourceLanguage = source;
    this._targetLanguage = target;
  }

  push(original, translation) {
    this._buffer.push({ original, translation });
    if (this._buffer.length > this._size) {
      this._buffer.shift();
    }
  }

  getContext() {
    return this._buffer.map(entry => entry.original);
  }

  getTranslationContext() {
    return this._buffer.map(entry => entry.translation);
  }

  getBilingualContext() {
    return [...this._buffer];
  }

  buildPrompt(currentText) {
    const context = this.getContext();
    const src = this._sourceLanguage;
    const tgt = this._targetLanguage;

    let prompt = '';

    if (src === 'ja' || tgt === 'ja') {
      prompt = `以下は${this._langName(src)}から${this._langName(tgt)}への翻訳です。\n`;
    } else if (src === 'zh' || tgt === 'zh') {
      prompt = `请将以下${this._langName(src)}翻译成${this._langName(tgt)}：\n`;
    } else if (src === 'ko' || tgt === 'ko') {
      prompt = `다음은 ${this._langName(src)}에서 ${this._langName(tgt)}로의 번역입니다:\n`;
    } else {
      prompt = `Translate from ${this._langName(src)} to ${this._langName(tgt)}:\n`;
    }

    if (context.length > 0) {
      prompt += `Context:\n${context.join('\n')}\n\n`;
    }

    prompt += `Translate: ${currentText}`;
    return prompt;
  }

  _langName(code) {
    const names = {
      en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
      fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese',
      ru: 'Russian', ar: 'Arabic', hi: 'Hindi', th: 'Thai',
    };
    return names[code] || code;
  }

  buildSystemPrompt(sourceLang, targetLang) {
    const src = sourceLang || this._sourceLanguage;
    const tgt = targetLang || this._targetLanguage;

    const prompts = {
      'en-zh': 'You are a professional subtitle translator. Translate the following English text to Chinese. ' +
               'Maintain the original meaning, tone, and style. For dialogue, keep it natural and conversational.',
      'en-ja': 'You are a professional subtitle translator. Translate the following English text to Japanese. ' +
               'Maintain the original meaning, tone, and style. Use appropriate honorifics for dialogue.',
      'en-ko': 'You are a professional subtitle translator. Translate the following English text to Korean. ' +
               'Maintain the original meaning, tone, and style.',
      'ja-zh': 'You are a professional subtitle translator. Translate the following Japanese text to Chinese. ' +
               'Maintain the original meaning, tone, and style. Pay attention to honorifics.',
    };

    const key = `${src}-${tgt}`;
    return prompts[key] || `Translate from ${this._langName(src)} to ${this._langName(tgt)}. ` +
           `Maintain the original meaning, tone, and style.`;
  }

  clear() {
    this._buffer = [];
  }

  get length() {
    return this._buffer.length;
  }

  isFull() {
    return this._buffer.length >= this._size;
  }
}

export const slidingWindow = new SlidingWindow();
export default SlidingWindow;

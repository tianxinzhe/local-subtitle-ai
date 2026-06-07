import { getSentenceEndings, getLanguage, SCRIPTS } from './languages.js';

const LANGUAGE_MERGE_THRESHOLD = {
  cjk: 30,
  latin: 50,
  arabic: 40,
  thai: 60,
  devanagari: 50,
  cyrillic: 50,
  korean: 40,
  greek: 50,
  hebrew: 40,
  other: 50,
};

class SentenceMerger {
  constructor() {
    this._buffer = [];
    this._bufferText = '';
    this._bufferStartTime = 0;
    this._bufferEndTime = 0;
    this._languageCode = 'en';
  }

  setLanguage(code) {
    this._languageCode = code;
  }

  feed(chunk, languageCode = null) {
    const lang = languageCode || this._languageCode;
    const endings = getSentenceEndings(lang);
    const threshold = this._getMergeThreshold(lang);

    if (this._buffer.length === 0) {
      this._bufferStartTime = chunk.start || 0;
    }

    this._buffer.push(chunk);
    this._bufferText += chunk.text || '';
    this._bufferEndTime = chunk.end || 0;

    const lastChar = this._bufferText.trim().slice(-1);
    const isComplete = endings.some(e => lastChar === e);
    const exceededThreshold = this._bufferText.length >= threshold;

    if (isComplete || exceededThreshold) {
      return this._flush();
    }

    return null;
  }

  _flush() {
    if (this._buffer.length === 0) return null;

    const mergedText = this._bufferText.trim();
    const result = {
      text: mergedText,
      start: this._bufferStartTime,
      end: this._bufferEndTime,
      segments: [...this._buffer],
      chunkCount: this._buffer.length,
    };

    this._buffer = [];
    this._bufferText = '';
    this._bufferStartTime = 0;
    this._bufferEndTime = 0;

    return result;
  }

  _getMergeThreshold(lang) {
    const langInfo = this._getLanguageInfo(lang);
    return LANGUAGE_MERGE_THRESHOLD[langInfo.script] || 50;
  }

  _getLanguageInfo(lang) {
    return getLanguage(lang) || { script: SCRIPTS.latin, rtl: false };
  }

  flushPending() {
    return this._flush();
  }

  getBufferLength() {
    return this._bufferText.length;
  }

  hasPending() {
    return this._buffer.length > 0;
  }

  reset() {
    this._buffer = [];
    this._bufferText = '';
    this._bufferStartTime = 0;
    this._bufferEndTime = 0;
  }
}

export const sentenceMerger = new SentenceMerger();
export default SentenceMerger;

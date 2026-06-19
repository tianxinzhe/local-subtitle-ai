import { isRtl } from './languages.js';

const EOL = '\r\n';

class SrtExporter {
  constructor() {
    this._segments = [];
  }

  addSegment(segment) {
    this._segments.push({
      index: this._segments.length + 1,
      start: segment.start || 0,
      end: segment.end || 0,
      original: segment.original || segment.text || '',
      translation: segment.translation || '',
      detectedLanguage: segment.detectedLanguage || null,
    });
  }

  addSegments(segments) {
    for (const seg of segments) {
      this.addSegment(seg);
    }
  }

  clear() {
    this._segments = [];
  }

  getSegments() {
    return [...this._segments];
  }

  getSegmentCount() {
    return this._segments.length;
  }

  _formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  exportBilingual(sourceLang = null, targetLang = null) {
    const lines = [];

    for (const seg of this._segments) {
      if (!seg.original && !seg.translation) continue;

      lines.push(String(seg.index));
      lines.push(`${this._formatTime(seg.start)} --> ${this._formatTime(seg.end)}`);

      const isRtlText = (sourceLang && isRtl(sourceLang));
      const isRtlTranslation = (targetLang && isRtl(targetLang));

      if (seg.original && seg.translation && seg.original !== seg.translation) {
        if (isRtlText) {
          lines.push(`\u202B${seg.original}\u202C`);
        } else {
          lines.push(seg.original);
        }
        if (isRtlTranslation) {
          lines.push(`\u202B${seg.translation}\u202C`);
        } else {
          lines.push(seg.translation);
        }
      } else {
        const text = seg.original || seg.translation;
        if (isRtlText || isRtlTranslation) {
          lines.push(`\u202B${text}\u202C`);
        } else {
          lines.push(text);
        }
      }

      lines.push('');
    }

    return lines.join(EOL);
  }

  exportOriginalOnly() {
    const lines = [];

    for (const seg of this._segments) {
      if (!seg.original) continue;
      lines.push(String(seg.index));
      lines.push(`${this._formatTime(seg.start)} --> ${this._formatTime(seg.end)}`);
      lines.push(seg.original);
      lines.push('');
    }

    return lines.join(EOL);
  }

  exportTranslatedOnly() {
    const lines = [];

    for (const seg of this._segments) {
      const text = seg.translation || seg.original;
      if (!text) continue;
      lines.push(String(seg.index));
      lines.push(`${this._formatTime(seg.start)} --> ${this._formatTime(seg.end)}`);
      lines.push(text);
      lines.push('');
    }

    return lines.join(EOL);
  }

  async download(bilingual = true, sourceLang = null, targetLang = null, filename = null) {
    let content;
    if (bilingual) {
      content = this.exportBilingual(sourceLang, targetLang);
    } else {
      content = this.exportTranslatedOnly();
    }

    if (!filename) {
      const lang = bilingual ? (targetLang || 'zh') : (sourceLang || 'auto');
      filename = `subtitles.${lang}.srt`;
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
      try {
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: true,
        }, (downloadId) => {
          URL.revokeObjectURL(url);
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(downloadId);
          }
        });
      } catch (err) {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        resolve(null);
      }
    });
  }

  toJson() {
    return JSON.stringify(this._segments, null, 2);
  }

  fromJson(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      this._segments = data.map((seg, i) => ({
        index: i + 1,
        start: seg.start || 0,
        end: seg.end || 0,
        original: seg.original || seg.text || '',
        translation: seg.translation || '',
        detectedLanguage: seg.detectedLanguage || null,
      }));
      return true;
    } catch {
      return false;
    }
  }

  sortByTime() {
    this._segments.sort((a, b) => a.start - b.start);
    this._segments.forEach((seg, i) => { seg.index = i + 1; });
  }

  mergeOverlapping() {
    if (this._segments.length === 0) return;

    this.sortByTime();
    const merged = [this._segments[0]];

    for (let i = 1; i < this._segments.length; i++) {
      const current = this._segments[i];
      const last = merged[merged.length - 1];

      if (current.start <= last.end) {
        last.end = Math.max(last.end, current.end);
        if (current.original && !last.original.includes(current.original)) {
          last.original += ' ' + current.original;
        }
        if (current.translation && !last.translation.includes(current.translation)) {
          last.translation += ' ' + current.translation;
        }
      } else {
        merged.push({ ...current });
      }
    }

    this._segments = merged;
    this._segments.forEach((seg, i) => { seg.index = i + 1; });
  }
}

export const srtExporter = new SrtExporter();
export default SrtExporter;

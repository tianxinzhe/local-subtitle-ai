import { loadConfig, saveConfig } from './config.js';

class I18n {
  constructor() {
    this.currentLanguage = 'en';
    this.messages = {};
    this._fallbackMessages = {};
    this._loaded = false;
  }

  async init() {
    const config = await loadConfig();
    this.currentLanguage = config.uiLanguage || 'en';
    await this._loadMessages(this.currentLanguage);
    await this._loadFallback();
    this._loaded = true;
  }

  async _loadMessages(lang) {
    try {
      const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
      const resp = await fetch(url);
      const data = await resp.json();
      this.messages = {};
      for (const [key, val] of Object.entries(data)) {
        this.messages[key] = val.message;
      }
    } catch {
      console.warn(`[i18n] Failed to load locale: ${lang}, falling back to en`);
      if (lang !== 'en') {
        await this._loadMessages('en');
      }
    }
  }

  async _loadFallback() {
    if (this.currentLanguage === 'en') return;
    try {
      const url = chrome.runtime.getURL('_locales/en/messages.json');
      const resp = await fetch(url);
      const data = await resp.json();
      this._fallbackMessages = {};
      for (const [key, val] of Object.entries(data)) {
        this._fallbackMessages[key] = val.message;
      }
    } catch {}
  }

  t(key, params = {}) {
    let msg = this.messages[key];
    if (msg === undefined) {
      msg = this._fallbackMessages[key];
    }
    if (msg === undefined) return key;
    if (params && Object.keys(params).length > 0) {
      msg = msg.replace(/\{\{(\w+)\}\}/g, (_, p) => {
        return params[p] !== undefined ? String(params[p]) : `{{${p}}}`;
      });
    }
    return msg;
  }

  async setLanguage(lang) {
    if (lang === this.currentLanguage && this._loaded) return;
    this.currentLanguage = lang;
    await this._loadMessages(lang);
    await this._loadFallback();
    await saveConfig({ uiLanguage: lang });
    try {
      await chrome.runtime.sendMessage({
        type: 'UI_LANGUAGE_CHANGED',
        language: lang
      });
    } catch {}
    this._notifyAllPages(lang);
  }

  async _notifyAllPages(lang) {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url && (tab.url.includes('sidepanel') || tab.url.includes('player'))) {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              type: 'UI_LANGUAGE_CHANGED',
              language: lang
            });
          } catch {}
        }
      }
    } catch {}
  }

  getCurrentLanguage() {
    return this.currentLanguage;
  }

  isLoaded() {
    return this._loaded;
  }
}

export const i18n = new I18n();

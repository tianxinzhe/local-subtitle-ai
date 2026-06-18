const STORAGE_KEY = 'local_ai_subtitles_config';

const DEFAULTS = {
  uiLanguage: 'en',
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  asrModel: 'base',
  subtitleFontSize: 18,
  subtitleColor: '#FFD700',
  subtitleBgOpacity: 0.6,
  exportBilingual: true,
  slidingWindowSize: 3,
  captureChunkInterval: 5,
  fullSpeedMode: true,
  extensionPayToken: null,
  nllbModelDownloaded: false,
  translationEngine: 'auto',
};

let cachedConfig = null;

export async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  cachedConfig = { ...DEFAULTS, ...(result[STORAGE_KEY] || {}) };
  return cachedConfig;
}

export async function saveConfig(updates) {
  const current = await loadConfig();
  cachedConfig = { ...current, ...updates };
  await chrome.storage.local.set({ [STORAGE_KEY]: cachedConfig });
  return cachedConfig;
}

export function getDefaults() {
  return { ...DEFAULTS };
}

export async function resetConfig() {
  cachedConfig = { ...DEFAULTS };
  await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULTS });
  return cachedConfig;
}

export async function get(key) {
  const cfg = await loadConfig();
  return cfg[key];
}

export async function set(key, value) {
  return saveConfig({ [key]: value });
}

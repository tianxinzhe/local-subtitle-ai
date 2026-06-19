import { loadConfig, saveConfig } from './modules/config.js';
import { i18n } from './modules/i18n.js';

let activeRequests = 0;

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await i18n.init();
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  console.log('[SW] Local AI Subtitles Pro installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  console.log('[SW] Service worker started');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (message.type) {
        case 'CONFIG_CHANGE':
          await saveConfig(message.updates);
          return { success: true };

        case 'UI_LANGUAGE_CHANGED':
          await i18n.setLanguage(message.language);
          return { success: true };

        case 'GET_CONFIG':
          return await loadConfig();

        case 'SET_CONFIG':
          await saveConfig(message.updates);
          return { success: true };

        default:
          return { error: `Unknown message type: ${message.type}` };
      }
    } catch (err) {
      console.error('[SW] Handler error:', err);
      return { error: err.message };
    }
  };

  handler().then(sendResponse);
  return true;
});

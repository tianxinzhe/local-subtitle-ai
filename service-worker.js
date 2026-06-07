import { loadConfig, saveConfig } from './modules/config.js';
import { i18n } from './modules/i18n.js';

let playerTabId = null;
let sidePanelPort = null;
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;
    port.onMessage.addListener(async (msg) => {
      await handleSidePanelMessage(msg, port);
    });
    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (message.type) {
        case 'ASR_REQUEST':
          return await handleAsrRequest(message, sender);

        case 'TRANSLATE_REQUEST':
          return await handleTranslateRequest(message);

        case 'SUBTITLE_SYNC':
          return await handleSubtitleSync(message);

        case 'CONFIG_CHANGE':
          return await handleConfigChange(message);

        case 'EXPORT_SRT':
          return await handleExportSrt(message);

        case 'PLAYER_READY':
          playerTabId = sender.tab?.id || null;
          return { success: true };

        case 'EXTRACT_COMPLETE':
          if (sidePanelPort) {
            try { sidePanelPort.postMessage({ type: 'EXTRACT_COMPLETE', count: message.count }); } catch {}
          }
          return { success: true };

        case 'PLAYER_CLOSED':
          playerTabId = null;
          return { success: true };

        case 'CAPTURE_START':
          return await handleCaptureStart(message, sender);

        case 'CAPTURE_STOP':
          return await handleCaptureStop();

        case 'UI_LANGUAGE_CHANGED':
          await i18n.setLanguage(message.language);
          return { success: true };

        case 'GET_CONFIG':
          return await loadConfig();

        case 'SET_CONFIG':
          await saveConfig(message.updates);
          return { success: true };

        case 'GET_STATUS':
          return getStatus();

        case 'OPEN_PLAYER':
          await openPlayerTab(message);
          return { success: true };

        case 'GET_CAPTURE_STREAM_ID':
          return await new Promise((resolve) => {
            chrome.tabCapture.getMediaStreamId({ targetTabId: message.targetTabId }, (streamId) => {
              if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
              } else {
                resolve(streamId);
              }
            });
          });

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

async function handleSidePanelMessage(msg, port) {
  switch (msg.type) {
    case 'OPEN_PLAYER':
      await openPlayerTab(msg);
      break;

    case 'ASR_RESULT':
      if (playerTabId) {
        try {
          await chrome.tabs.sendMessage(playerTabId, msg);
        } catch {}
      }
      break;

    case 'TRANSLATE_RESULT':
      if (playerTabId) {
        try {
          await chrome.tabs.sendMessage(playerTabId, msg);
        } catch {}
      }
      break;

    case 'SUBTITLE_SYNC':
      if (playerTabId) {
        try {
          await chrome.tabs.sendMessage(playerTabId, msg);
        } catch {}
      }
      break;

    case 'CAPTURE_AUDIO_DATA':
      if (sidePanelPort) {
        try {
          sidePanelPort.postMessage(msg);
        } catch {}
      }
      break;
  }
}

async function handleAsrRequest(message, sender) {
  activeRequests++;

  if (sidePanelPort) {
    try {
      sidePanelPort.postMessage({
        type: 'ASR_REQUEST',
        audio: message.audio,
        timestamp: message.timestamp,
        requestId: message.requestId,
        options: message.options || {},
      });
    } catch {}
  }

  activeRequests--;
  return { success: true };
}

async function handleTranslateRequest(message) {
  activeRequests++;

  if (sidePanelPort) {
    try {
      sidePanelPort.postMessage({
        type: 'TRANSLATE_REQUEST',
        text: message.text,
        sourceLang: message.sourceLang,
        targetLang: message.targetLang,
        context: message.context,
        requestId: message.requestId,
      });
    } catch {}
  }

  activeRequests--;
  return { success: true };
}

async function handleSubtitleSync(message) {
  if (playerTabId) {
    try {
      await chrome.tabs.sendMessage(playerTabId, {
        type: 'SUBTITLE_SYNC',
        subtitles: message.subtitles,
        timestamp: message.timestamp,
      });
    } catch {}
  }
  return { success: true };
}

async function handleConfigChange(message) {
  await saveConfig(message.updates);

  if (sidePanelPort) {
    try {
      sidePanelPort.postMessage({ type: 'CONFIG_UPDATED', updates: message.updates });
    } catch {}
  }

  if (playerTabId) {
    try {
      await chrome.tabs.sendMessage(playerTabId, {
        type: 'CONFIG_UPDATED',
        updates: message.updates,
      });
    } catch {}
  }

  return { success: true };
}

async function handleExportSrt(message) {
  if (sidePanelPort) {
    try {
      sidePanelPort.postMessage({ type: 'EXPORT_SRT', ...message });
    } catch {}
  }
  return { success: true };
}

async function handleCaptureStart(message, sender) {
  try {
    const config = await loadConfig();
    const tabId = message.tabId || sender.tab?.id;

    if (!tabId) {
      throw new Error('No tab ID provided for capture');
    }

    return { success: true };
  } catch (err) {
    console.error('[SW] Capture start failed:', err);
    return { error: err.message };
  }
}

async function handleCaptureStop() {
  if (sidePanelPort) {
    try {
      sidePanelPort.postMessage({ type: 'CAPTURE_STOPPED' });
    } catch {}
  }

  return { success: true };
}

async function openPlayerTab(msg) {
  try {
    const url = chrome.runtime.getURL('player/index.html');
    const tab = await chrome.tabs.create({ url, active: true });
    playerTabId = tab.id;
  } catch (err) {
    console.error('[SW] Failed to open player tab:', err);
  }
}

function getStatus() {
  return {
    playerTabId,
    sidePanelConnected: !!sidePanelPort,
    activeRequests,
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === playerTabId) {
    playerTabId = null;
    if (sidePanelPort) {
      try {
        sidePanelPort.postMessage({ type: 'PLAYER_CLOSED' });
      } catch {}
    }
  }
});

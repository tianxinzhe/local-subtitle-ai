import { loadConfig, saveConfig } from '../modules/config.js';
import { i18n } from '../modules/i18n.js';
import { audioProcessor } from '../modules/audio-processor.js';
import { getAllLanguages, getLanguage, isRtl } from '../modules/languages.js';
import { fileStore } from '../modules/file-store.js';

const $ = (id) => document.getElementById(id);

let playerReady = false;
let currentSubtitle = null;
let subtitleTimeout = null;
let detectionInterval = null;
let lastProcessedTime = 0;
let lastSubtitleEnd = 0;
let audioCaptureStream = null;
let audioCaptureRecorder = null;
let extractMode = false;

function localizeHtml() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = i18n.t(el.getAttribute('data-i18n'));
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = i18n.t(el.getAttribute('data-i18n-title'));
  }
  document.documentElement.lang = i18n.getCurrentLanguage();
}

async function init() {
  await i18n.init();
  localizeHtml();
  setupEventListeners();
  setupMessageListeners();
  setupVideoListeners();
  notifyPlayerReady();
  await populateLanguageDropdowns();
  await loadSettings();
  await loadPendingFile();
}

async function loadPendingFile() {
  try {
    const file = await fileStore.load('pendingVideo');
    if (file) {
      const name = await fileStore.load('pendingVideoName') || file.name;
      const extract = await fileStore.load('extractMode');
      extractMode = !!extract;
      const url = URL.createObjectURL(file);
      const video = $('videoPlayer');
      video.src = url;
      video.load();
      $('loadingOverlay').classList.remove('hidden');
      $('loadingText').textContent = name;
      video.addEventListener('canplay', () => {
        $('loadingOverlay').classList.add('hidden');
        showToast('Video loaded: ' + name);
        if (extractMode) {
          video.play();
        }
      }, { once: true });
      await fileStore.remove('pendingVideo');
      await fileStore.remove('pendingVideoName');
      await fileStore.remove('extractMode');
    }
  } catch (err) {
    console.error('[Player] Failed to load pending file:', err);
  }
}



function notifyPlayerReady() {
  try {
    chrome.runtime.sendMessage({ type: 'PLAYER_READY' });
  } catch {}
}

async function populateLanguageDropdowns() {
  const sourceSelect = $('playerSourceLang');
  const targetSelect = $('playerTargetLang');
  const languages = getAllLanguages();
  const uiLang = i18n.getCurrentLanguage();

  sourceSelect.innerHTML = '<option value="auto">' + i18n.t('option_auto_detect') + '</option>';
  targetSelect.innerHTML = '';

  for (const lang of languages) {
    const name = lang.name[uiLang] || lang.name.en;

    const opt1 = document.createElement('option');
    opt1.value = lang.code;
    opt1.textContent = name;
    sourceSelect.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = lang.code;
    opt2.textContent = name;
    targetSelect.appendChild(opt2);
  }
}

async function loadSettings() {
  const config = await loadConfig();
  $('playerSourceLang').value = config.sourceLanguage || 'auto';
  $('playerTargetLang').value = config.targetLanguage || 'zh';
}

function setupEventListeners() {
  $('playerSourceLang').addEventListener('change', async () => {
    await saveConfig({ sourceLanguage: $('playerSourceLang').value });
    try {
      await chrome.runtime.sendMessage({
        type: 'CONFIG_CHANGE',
        updates: { sourceLanguage: $('playerSourceLang').value },
      });
    } catch {}
  });

  $('playerTargetLang').addEventListener('change', async () => {
    await saveConfig({ targetLanguage: $('playerTargetLang').value });
    try {
      await chrome.runtime.sendMessage({
        type: 'CONFIG_CHANGE',
        updates: { targetLanguage: $('playerTargetLang').value },
      });
    } catch {}
  });

  $('fullscreenBtn').addEventListener('click', toggleFullscreen);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    }
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
  });

  $('videoContainer').addEventListener('dblclick', toggleFullscreen);

  $('videoContainer').addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  $('videoContainer').addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      await loadVideoFile(e.dataTransfer.files[0]);
    }
  });
}

function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'SUBTITLE_SYNC':
        displaySubtitle(msg.subtitles);
        break;

      case 'CONFIG_UPDATED':
        if (msg.updates) {
          if (msg.updates.sourceLanguage !== undefined) {
            $('playerSourceLang').value = msg.updates.sourceLanguage;
          }
          if (msg.updates.targetLanguage !== undefined) {
            $('playerTargetLang').value = msg.updates.targetLanguage;
          }
        }
        break;

      case 'UI_LANGUAGE_CHANGED':
        location.reload();
        break;

      case 'ASR_RESULT':
        break;
    }
  });
}

function setupVideoListeners() {
  const video = $('videoPlayer');

  video.addEventListener('timeupdate', () => {
    const ct = video.currentTime;
    if (Math.abs(ct - lastProcessedTime) >= 2 && ct > lastSubtitleEnd + 0.5) {
      maybeExtractAudio();
    }
  });

  video.addEventListener('pause', () => {
    stopDetection();
  });

  video.addEventListener('play', () => {
    startDetection();
  });

  video.addEventListener('loadedmetadata', () => {
    $('loadingOverlay').classList.add('hidden');
  });

  video.addEventListener('ended', () => {
    stopDetection();
    if (extractMode) {
      try { chrome.runtime.sendMessage({ type: 'EXTRACT_COMPLETE' }); } catch {}
    }
  });

  video.addEventListener('error', (e) => {
    showToast('Video error: ' + (video.error?.message || 'Unknown'));
  });
}

async function loadVideoFile(file) {
  const video = $('videoPlayer');
  const url = URL.createObjectURL(file);
  video.src = url;

  $('loadingOverlay').classList.remove('hidden');
  $('loadingText').textContent = file.name;

  video.addEventListener('canplay', () => {
    $('loadingOverlay').classList.add('hidden');
    showToast('Video loaded: ' + file.name);
  }, { once: true });
}

function startDetection() {
  if (detectionInterval) return;

  detectionInterval = setInterval(() => {
    const video = $('videoPlayer');
    if (video.paused || !video.src) return;

    const ct = video.currentTime;
    if (Math.abs(ct - lastProcessedTime) >= 2 && ct > lastSubtitleEnd + 0.5) {
      maybeExtractAudio();
    }
  }, 1000);
}

function stopDetection() {
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }
}

async function maybeExtractAudio() {
  const video = $('videoPlayer');
  const ct = video.currentTime;

  lastProcessedTime = ct;

  const audioData = await extractCurrentAudio(ct, 3);

  if (audioData) {
    try {
      await chrome.runtime.sendMessage({
        type: 'ASR_REQUEST',
        audio: audioData,
        timestamp: ct,
        requestId: Date.now().toString(36),
        options: {},
      });
    } catch (err) {
      if (err.message && err.message.includes('Receiving end does not exist')) {
      }
    }
  }
}

function ensureCaptureStream() {
  const video = $('videoPlayer');
  if (audioCaptureStream) return audioCaptureStream;
  try {
    audioCaptureStream = video.captureStream();
  } catch (e) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createMediaElementSource(video);
    src.connect(dest);
    audioCaptureStream = dest.stream;
  }
  return audioCaptureStream;
}

async function captureAudioSegment(durationSec) {
  const stream = ensureCaptureStream();
  return new Promise((resolve) => {
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    audioCaptureRecorder = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const buf = await blob.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const audioBuf = await ctx.decodeAudioData(buf);
      resolve(audioBuf.getChannelData(0));
      ctx.close();
    };
    recorder.start();
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, durationSec * 1000);
  });
}

async function extractCurrentAudio(currentTime, durationSec) {
  const video = $('videoPlayer');
  if (!video.src || video.paused) return null;
  return captureAudioSegment(durationSec);
}

function displaySubtitle(subtitles) {
  if (!subtitles || subtitles.length === 0) return;

  const sub = subtitles[0];
  currentSubtitle = sub;

  const track = $('subtitleTrack');
  track.innerHTML = '';
  track.classList.remove('hidden');

  if (sub.rtl || (sub.detectedLanguage && isRtl(sub.detectedLanguage))) {
    track.classList.add('rtl');
  } else {
    track.classList.remove('rtl');
  }

  if (sub.original && sub.translation && sub.original !== sub.translation) {
    const origLine = document.createElement('div');
    origLine.className = 'original-line';
    origLine.textContent = sub.original;
    track.appendChild(origLine);

    const transLine = document.createElement('div');
    transLine.className = 'translation-line';
    transLine.textContent = sub.translation;
    track.appendChild(transLine);
  } else {
    track.textContent = sub.translation || sub.original || '';
  }

  lastSubtitleEnd = sub.end || 0;

  const duration = (sub.end || 3) - (sub.start || 0);
  if (subtitleTimeout) {
    clearTimeout(subtitleTimeout);
  }

  subtitleTimeout = setTimeout(() => {
    track.classList.add('hidden');
    currentSubtitle = null;
  }, Math.max(duration * 1000, 3000));
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function togglePlay() {
  const video = $('videoPlayer');
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._hideTimeout);
  toast._hideTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

document.addEventListener('DOMContentLoaded', init);

function cleanupCapture() {
  if (audioCaptureRecorder && audioCaptureRecorder.state === 'recording') {
    audioCaptureRecorder.stop();
    audioCaptureRecorder = null;
  }
  audioCaptureStream = null;
}

window.addEventListener('beforeunload', () => {
  stopDetection();
  cleanupCapture();
  try {
    chrome.runtime.sendMessage({ type: 'PLAYER_CLOSED' });
  } catch {}
});

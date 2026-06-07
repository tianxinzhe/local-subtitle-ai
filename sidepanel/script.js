import { loadConfig, saveConfig, get } from '../modules/config.js';
import { i18n } from '../modules/i18n.js';
import { whisper } from '../modules/whisper.js';
import { translator } from '../modules/translator.js';
import { audioProcessor } from '../modules/audio-processor.js';
import { sentenceMerger } from '../modules/sentence-merger.js';
import { slidingWindow } from '../modules/sliding-window.js';
import { srtExporter } from '../modules/srt-exporter.js';
import { getAllLanguages, getLanguage, getLanguageDisplayName, isRtl } from '../modules/languages.js';
import { fileStore } from '../modules/file-store.js';

let backgroundPort = null;
let currentFile = null;
let isProcessing = false;
let isAiReady = false;
let isCapturing = false;
let isExtracting = false;
let fullSpeedMode = false;
let captureStream = null;
let captureAudioContext = null;

const $ = (id) => document.getElementById(id);

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
  await connectBackground();
  await populateLanguageDropdowns();
  await loadSettings();
  setupEventListeners();
  setModeCardsEnabled(false);
}

async function connectBackground() {
  backgroundPort = chrome.runtime.connect({ name: 'sidepanel' });

  backgroundPort.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case 'ASR_REQUEST':
        await handleAsrRequest(msg);
        break;
      case 'TRANSLATE_REQUEST':
        await handleTranslateRequest(msg);
        break;
      case 'CONFIG_UPDATED':
        await onConfigUpdated(msg.updates);
        break;
      case 'PLAYER_CLOSED':
        onPlayerClosed();
        break;
      case 'EXTRACT_COMPLETE':
        onExtractDone(msg.count);
        break;
      case 'CAPTURE_STOPPED':
        onCaptureStopped();
        break;
    }
  });

  backgroundPort.onDisconnect.addListener(() => {
    backgroundPort = null;
    setTimeout(connectBackground, 1000);
  });
}

async function populateLanguageDropdowns() {
  const sourceSelect = $('sourceLang');
  const targetSelect = $('targetLang');

  const languages = getAllLanguages();
  const uiLang = i18n.getCurrentLanguage();

  targetSelect.innerHTML = '';
  for (const lang of languages) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name[uiLang] || lang.name.en;
    targetSelect.appendChild(opt);
  }

  sourceSelect.innerHTML = '<option value="auto">' + i18n.t('option_auto_detect') + '</option>';
  for (const lang of languages) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name[uiLang] || lang.name.en;
    sourceSelect.appendChild(opt);
  }
}

async function loadSettings() {
  const config = await loadConfig();

  $('sourceLang').value = config.sourceLanguage || 'auto';
  $('targetLang').value = config.targetLanguage || 'zh';

  $('settingUiLang').value = config.uiLanguage || 'en';
  $('settingAsrModel').value = config.asrModel || 'tiny';
  $('settingFontSize').value = config.subtitleFontSize || 18;
  $('settingFontColor').value = config.subtitleColor || '#FFD700';
  $('settingBgOpacity').value = config.subtitleBgOpacity || 0.6;
}

function setModeCardsEnabled(enabled) {
  const cards = document.querySelectorAll('.mode-card');
  cards.forEach(c => c.classList.toggle('disabled', !enabled));
  $('captureBtn').disabled = !enabled;
}

function setupEventListeners() {
  $('activateBtn').addEventListener('click', toggleAi);

  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileDrop(e.target.files[0]);
    }
  });

  const dropZone = $('dropZone');
  dropZone.addEventListener('click', () => $('fileInput').click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleFileDrop(e.dataTransfer.files[0]);
    }
  });

  $('captureBtn').addEventListener('click', toggleCapture);

  $('fullSpeedToggle').addEventListener('click', toggleFullSpeed);

  $('sourceLang').addEventListener('change', async () => {
    const val = $('sourceLang').value;
    await saveConfig({ sourceLanguage: val });
    try {
      await chrome.runtime.sendMessage({
        type: 'CONFIG_CHANGE',
        updates: { sourceLanguage: val },
      });
    } catch {}
  });

  $('targetLang').addEventListener('change', async () => {
    const val = $('targetLang').value;
    await saveConfig({ targetLanguage: val });
    try {
      await chrome.runtime.sendMessage({
        type: 'CONFIG_CHANGE',
        updates: { targetLanguage: val },
      });
    } catch {}
  });

  $('exportBtn').addEventListener('click', exportSrt);

  $('settingsBtn').addEventListener('click', () => {
    $('settingsPanel').classList.remove('hidden');
  });

  $('closeSettings').addEventListener('click', () => {
    $('settingsPanel').classList.add('hidden');
  });

  $('settingUiLang').addEventListener('change', async () => {
    const lang = $('settingUiLang').value;
    await i18n.setLanguage(lang);
    await populateLanguageDropdowns();
    await loadSettings();
    location.reload();
  });

  $('settingAsrModel').addEventListener('change', async () => {
    await saveConfig({ asrModel: $('settingAsrModel').value });
  });

  $('settingFontSize').addEventListener('change', async () => {
    await saveConfig({ subtitleFontSize: parseInt($('settingFontSize').value) });
  });

  $('settingFontColor').addEventListener('change', async () => {
    await saveConfig({ subtitleColor: $('settingFontColor').value });
  });

  $('settingBgOpacity').addEventListener('input', async () => {
    await saveConfig({ subtitleBgOpacity: parseFloat($('settingBgOpacity').value) });
  });

  $('playBtn').addEventListener('click', () => {
    if (currentFile) openPlayer(currentFile);
  });

  $('extractBtn').addEventListener('click', () => {
    if (currentFile) extractDirect(currentFile);
  });

  $('settingsPanel').addEventListener('click', (e) => {
    if (e.target === $('settingsPanel')) {
      $('settingsPanel').classList.add('hidden');
    }
  });

  $('downloadAudioBtn').addEventListener('click', downloadExtractedAudio);
  $('downloadSrtBtn').addEventListener('click', downloadExtractedSrt);
}

async function toggleAi() {
  if (isAiReady) {
    return;
  }

  const btn = $('activateBtn');
  const progressContainer = $('progressContainer');
  const progressFill = $('progressFill');
  const progressLabel = $('progressLabel');
  const statusBadge = $('statusBadge');

  btn.disabled = true;
  progressContainer.classList.remove('hidden');
  statusBadge.className = 'status-loading';
  $('statusText').textContent = i18n.t('status_downloading_model');

  try {
    await whisper.load({
      onProgress: (pct, stage) => {
        progressFill.style.width = pct + '%';
        progressLabel.textContent = pct + '%';

        if (stage === 'downloading') {
          $('statusText').textContent = i18n.t('status_downloading_model', { progress: pct });
        } else if (stage === 'ready' || stage === 'loaded') {
          $('statusText').textContent = i18n.t('status_model_ready');
        }
      },
    });

    await translator.init({
      onProgress: (pct, stage) => {
        if (stage === 'gemini_ready') {
          $('statusText').textContent = i18n.t('msg_engine_gemini');
        } else if (stage === 'onnx_ready') {
          $('statusText').textContent = i18n.t('msg_engine_onnx');
        }
      },
    });

    isAiReady = true;
    btn.disabled = false;
    progressContainer.classList.add('hidden');
    statusBadge.className = 'status-ready';
    $('statusText').textContent = i18n.t('status_model_ready');
    setModeCardsEnabled(true);
  } catch (err) {
    btn.disabled = false;
    progressContainer.classList.add('hidden');
    statusBadge.className = 'status-error';
    $('statusText').textContent = i18n.t('status_model_failed');
    console.error('[SidePanel] AI init failed:', err);
  }
}

function handleFileDrop(file) {
  if (!isAiReady) {
    showToast('Please activate AI first');
    setStatus('error', 'Please activate AI first');
    return;
  }

  currentFile = file;
  $('dropText').textContent = file.name;
  $('fileNameDisplay').textContent = file.name;
  $('fileInfo').classList.remove('hidden');
  $('fileActions').classList.remove('hidden');
  $('extractProgress').classList.add('hidden');
  $('modeLocal').classList.add('active');
  setStatus('ready', i18n.t('status_idle'));
}

async function openPlayer(file, extractMode) {
  await fileStore.save('pendingVideo', file);
  await fileStore.save('pendingVideoName', file.name);
  await fileStore.save('extractMode', !!extractMode);
  const msg = { type: 'OPEN_PLAYER', fileName: file.name, fileSize: file.size, extractMode: !!extractMode };
  if (backgroundPort) {
    try { backgroundPort.postMessage(msg); return; } catch {}
  }
  try { await chrome.runtime.sendMessage(msg); } catch {}
}

async function extractDirect(file) {
  $('fileActions').classList.add('hidden');
  $('extractProgress').classList.remove('hidden');
  $('extractBtn').disabled = true;
  $('extractFill').style.width = '0%';
  $('extractStatus').textContent = i18n.t('status_extracting_audio');

  srtExporter.clear();
  sentenceMerger.reset?.();
  $('subtitleList').innerHTML = '<div id="emptyState" class="empty-state">No subtitles yet</div>';
  $('subtitleCount').textContent = '0';
  isExtracting = true;

  const audioChunks = [];
  let hasAudio = false, hasSrt = false;
  $('extractDownloads').classList.add('hidden');
  $('downloadAudioBtn').disabled = true;
  $('downloadSrtBtn').disabled = true;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.display = 'none';
  document.body.appendChild(video);

  let audioCtx = null;
  const blobUrl = URL.createObjectURL(file);

  try {
    const config = await loadConfig();
    const sourceLang = config.sourceLanguage || 'auto';
    const targetLang = config.targetLanguage || 'zh';
    const doTranslate = !!targetLang && targetLang !== sourceLang;

    video.src = blobUrl;
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Cannot load this file')), { once: true });
    });

    const duration = video.duration;
    if (!duration || !isFinite(duration)) {
      throw new Error('Cannot determine media duration');
    }

    const stream = video.captureStream();
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const sourceNode = audioCtx.createMediaStreamSource(stream);
    const destNode = audioCtx.createMediaStreamDestination();
    sourceNode.connect(destNode);

    const SEG = 15;
    await video.play();

    for (let t = 0; t < duration && isExtracting; t += SEG) {
      const dur = Math.min(SEG, duration - t);

      const webmBlob = await recordSegment(destNode.stream, dur);
      const audioData = await webmToFloat32(webmBlob);
      audioChunks.push(audioData);
      window._extractedAudioChunks = audioChunks;
      if (!hasAudio) {
        hasAudio = true;
        $('extractDownloads').classList.remove('hidden');
        $('downloadAudioBtn').disabled = false;
      }

      const result = await whisper.transcribe(audioData, {
        returnTimestamps: true,
        forceLanguage: sourceLang !== 'auto' ? sourceLang : null,
      });

      const detectedLang = result.detectedLanguage || sourceLang || 'en';

      if (result.text && result.text.trim()) {
        if (!hasSrt) { hasSrt = true; $('extractDownloads').classList.remove('hidden'); $('downloadSrtBtn').disabled = false; }
        const translation = doTranslate
          ? await translator.translate(result.text, detectedLang, targetLang, [])
          : '';
        srtExporter.addSegment({
          start: t,
          end: t + dur,
          original: result.text.trim(),
          translation,
          detectedLanguage: detectedLang,
        });
        addSubtitleCard(t, result.text.trim(), translation, isRtl(detectedLang) || isRtl(targetLang));
      }

      const pct = Math.min(100, Math.round(((t + dur) / duration) * 100));
      $('extractFill').style.width = pct + '%';
      $('extractStatus').textContent = i18n.t('status_extracting_progress', { progress: pct });
    }

    video.pause();
    onExtractDone(srtExporter.getSegmentCount());

  } catch (err) {
    console.error('[SidePanel] Extract error:', err);
    $('extractStatus').textContent = 'Error: ' + err.message;
    setStatus('error', err.message);
    $('extractBtn').disabled = false;
    isExtracting = false;
  } finally {
    if (audioCtx) audioCtx.close();
    URL.revokeObjectURL(blobUrl);
    if (video.parentNode) document.body.removeChild(video);
  }
}

function recordSegment(stream, durationSec) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    } catch (e) {
      rec = new MediaRecorder(stream);
    }
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));
    rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
    rec.start();
    setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, durationSec * 1000);
  });
}

async function webmToFloat32(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  try {
    const audioBuf = await ctx.decodeAudioData(buf);
    const data = audioBuf.getChannelData(0);
    return new Float32Array(data);
  } finally {
    ctx.close();
  }
}

function onExtractDone(count) {
  isExtracting = false;
  const c = typeof count === 'number' ? count : srtExporter.getSegmentCount();
  $('extractFill').style.width = '100%';
  $('extractStatus').textContent = i18n.t('status_extract_done', { count: c });
  updateExportButton();
  setStatus('ready', i18n.t('status_idle'));
  $('extractBtn').disabled = false;
}

async function handleAsrRequest(msg) {
  if (!msg.audio || !isAiReady) return;

  setStatus('processing', i18n.t('status_transcribing'));

  try {
    const config = await loadConfig();
    const sourceLang = config.sourceLanguage;

    const result = await whisper.transcribe(msg.audio, {
      forceLanguage: sourceLang !== 'auto' ? sourceLang : null,
      returnTimestamps: true,
    });

    const detectedLang = result.detectedLanguage || sourceLang || 'en';

    if (sourceLang === 'auto' && detectedLang) {
      $('sourceLang').value = detectedLang;
      await saveConfig({ sourceLanguage: detectedLang });
    }

    const merged = sentenceMerger.feed({
      text: result.text,
      start: msg.timestamp || 0,
      end: (msg.timestamp || 0) + result.duration,
    }, detectedLang);

    if (merged) {
      await translateAndSend(merged, detectedLang);
    }

    if (backgroundPort) {
      backgroundPort.postMessage({
        type: 'ASR_RESULT',
        text: result.text,
        detectedLanguage: detectedLang,
        timestamp: msg.timestamp,
        requestId: msg.requestId,
      });
    }

    setStatus('ready', i18n.t('status_idle'));
  } catch (err) {
    console.error('[SidePanel] ASR error:', err);
    setStatus('error', i18n.t('status_error', { error: err.message }));
  }
}

async function handleTranslateRequest(msg) {
  setStatus('processing', i18n.t('status_translating'));

  try {
    const translation = await translator.translate(
      msg.text,
      msg.sourceLang,
      msg.targetLang,
      msg.context || []
    );

    if (backgroundPort) {
      backgroundPort.postMessage({
        type: 'TRANSLATE_RESULT',
        text: translation,
        requestId: msg.requestId,
      });
    }

    setStatus('ready', i18n.t('status_idle'));
  } catch (err) {
    console.error('[SidePanel] Translate error:', err);
    setStatus('error', i18n.t('status_error', { error: err.message }));
  }
}

async function translateAndSend(merged, detectedLang) {
  const config = await loadConfig();
  const targetLang = config.targetLanguage || 'zh';
  const ctxSize = config.slidingWindowSize || 3;

  slidingWindow.setSize(ctxSize);
  slidingWindow.setLanguages(detectedLang, targetLang);

  setStatus('processing', i18n.t('status_translating'));

  try {
    const context = slidingWindow.getContext();
    const translation = await translator.translate(
      merged.text,
      detectedLang,
      targetLang,
      context
    );

    slidingWindow.push(merged.text, translation);

    const rtl = isRtl(detectedLang) || isRtl(targetLang);

    srtExporter.addSegment({
      start: merged.start,
      end: merged.end,
      original: merged.text,
      translation,
      detectedLanguage: detectedLang,
    });

    addSubtitleCard(merged.start, merged.text, translation, rtl);

    if (backgroundPort) {
      backgroundPort.postMessage({
        type: 'SUBTITLE_SYNC',
        subtitles: [{
          start: merged.start,
          end: merged.end,
          original: merged.text,
          translation,
          rtl,
        }],
      });
    }

    updateExportButton();
  } catch (err) {
    console.error('[SidePanel] Translate error:', err);
  }

  setStatus('ready', i18n.t('status_idle'));
}

function addSubtitleCard(timestamp, original, translation, rtl) {
  const list = $('subtitleList');
  const emptyState = $('emptyState');

  if (emptyState) {
    emptyState.remove();
  }

  const card = document.createElement('div');
  card.className = 'subtitle-card';

  const timeStr = formatTimestamp(timestamp);

  const timeEl = document.createElement('div');
  timeEl.className = 'timestamp';
  timeEl.textContent = timeStr;
  card.appendChild(timeEl);

  if (original) {
    const origEl = document.createElement('div');
    origEl.className = 'original' + (rtl ? ' rtl' : '');
    origEl.textContent = original;
    card.appendChild(origEl);
  }

  if (translation && translation !== original) {
    const transEl = document.createElement('div');
    transEl.className = 'translation' + (rtl ? ' rtl' : '');
    transEl.textContent = translation;
    card.appendChild(transEl);
  }

  list.appendChild(card);
  list.scrollTop = list.scrollHeight;

  const count = srtExporter.getSegmentCount();
  $('subtitleCount').textContent = count;
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateExportButton() {
  const count = srtExporter.getSegmentCount();
  $('exportBtn').disabled = count === 0;
}

async function exportSrt() {
  if (srtExporter.getSegmentCount() === 0) return;

  const config = await loadConfig();
  $('exportBtn').disabled = true;
  $('exportBtn').textContent = i18n.t('status_exporting');

  try {
    await srtExporter.download(
      config.exportBilingual !== false,
      config.sourceLanguage,
      config.targetLanguage
    );
  } catch (err) {
    console.error('[SidePanel] Export failed:', err);
  }

  $('exportBtn').disabled = false;
  $('exportBtn').innerHTML = '<span class="icon">📥</span><span>' + i18n.t('btn_export_srt') + '</span>';
}

function float32ToWavBlob(float32Array, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = float32Array.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function downloadExtractedAudio() {
  if (!window._extractedAudioChunks || window._extractedAudioChunks.length === 0) return;
  const totalLen = window._extractedAudioChunks.reduce((s, c) => s + c.length, 0);
  const combined = new Float32Array(totalLen);
  let offset = 0;
  for (const c of window._extractedAudioChunks) {
    combined.set(c, offset);
    offset += c.length;
  }
  const blob = float32ToWavBlob(combined, 16000);
  const url = URL.createObjectURL(blob);
  const name = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') + '_audio.wav' : 'extracted_audio.wav';
  try {
    chrome.downloads.download({ url, filename: name, saveAs: true }, () => {
      URL.revokeObjectURL(url);
    });
  } catch {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function downloadExtractedSrt() {
  if (srtExporter.getSegmentCount() === 0) return;
  const content = srtExporter.exportOriginalOnly();
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/srt;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const name = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') + '_original.srt' : 'subtitles_original.srt';
  try {
    chrome.downloads.download({ url, filename: name, saveAs: true }, () => {
      URL.revokeObjectURL(url);
    });
  } catch {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function toggleCapture() {
  if (isCapturing) {
    await stopCapture();
  } else {
    await startCapture();
  }
}

async function startCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setStatus('error', i18n.t('error_capture_no_tab'));
      return;
    }

    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
      setStatus('error', i18n.t('error_capture_chrome_page'));
      return;
    }

    setStatus('processing', i18n.t('status_requesting_capture'));

    const streamId = await chrome.runtime.sendMessage({
      type: 'GET_CAPTURE_STREAM_ID',
      targetTabId: tab.id,
    });

    if (!streamId || streamId.error) {
      const msg = streamId?.error || '';
      if (msg.includes('not been invoked') || msg.includes('activeTab')) {
        setStatus('error', i18n.t('error_capture_switch_tab'));
        $('captureInfo').classList.remove('hidden');
        $('captureInfo').innerHTML = '<span class="mode-info-dot"></span><span>' + i18n.t('hint_capture_retry') + '</span>';
        showToast(i18n.t('hint_capture_retry'));
      } else {
        setStatus('error', msg || i18n.t('error_capture_no_tab'));
      }
      return;
    }

    captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    await chrome.runtime.sendMessage({
      type: 'CAPTURE_START',
      tabId: tab.id,
    }).catch(() => {});

    $('captureBtn').innerHTML = '<span class="btn-icon">⏹</span><span class="btn-text">' + i18n.t('btn_stop_capture') + '</span>';
    $('captureBtn').classList.add('capturing');
    $('captureInfo').classList.remove('hidden');
    $('modeOnline').classList.add('active');
    isCapturing = true;

    await audioProcessor.captureTabAudio(captureStream, {
      onData: async (chunk) => {
        if (!isAiReady) return;

        const result = await whisper.transcribe(chunk.data, {
          returnTimestamps: true,
        });

        const config = await loadConfig();
        const sourceLang = config.sourceLanguage;
        const detectedLang = result.detectedLanguage || sourceLang || 'en';

        const merged = sentenceMerger.feed({
          text: result.text,
          start: chunk.timestamp / 1000,
          end: (chunk.timestamp / 1000) + chunk.duration,
        }, detectedLang);

        if (merged) {
          await translateAndSend(merged, detectedLang);
        }
      },
      chunkInterval: 5,
    });

  } catch (err) {
    console.error('[SidePanel] Capture error:', err);
    setStatus('error', err.message);
    await stopCapture();
  }
}

async function stopCapture() {
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }

  await chrome.runtime.sendMessage({ type: 'CAPTURE_STOP' });

  isCapturing = false;
  $('captureBtn').innerHTML = '<span class="btn-icon">🎤</span><span class="btn-text">' + i18n.t('btn_capture_audio') + '</span>';
  $('captureBtn').classList.remove('capturing');
  $('captureInfo').classList.add('hidden');
  $('modeOnline').classList.remove('active');
}

function onCaptureStopped() {
  isCapturing = false;
  $('captureBtn').innerHTML = '<span class="btn-icon">🎤</span><span class="btn-text">' + i18n.t('btn_capture_audio') + '</span>';
  $('captureBtn').classList.remove('capturing');
  $('captureInfo').classList.add('hidden');
  $('modeOnline').classList.remove('active');
}

function toggleFullSpeed() {
  fullSpeedMode = !fullSpeedMode;
  $('fullSpeedToggle').classList.toggle('active', fullSpeedMode);
}

function onConfigUpdated(updates) {
  if (updates.sourceLanguage !== undefined) {
    $('sourceLang').value = updates.sourceLanguage;
  }
  if (updates.targetLanguage !== undefined) {
    $('targetLang').value = updates.targetLanguage;
  }
}

function onPlayerClosed() {
}

function setStatus(type, text) {
  const badge = $('statusBadge');
  badge.className = 'status-' + type;
  $('statusText').textContent = text;
}

function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#e74c3c;color:#fff;padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;transition:opacity .3s;text-align:center;max-width:90%';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._hide);
  el._hide = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

document.addEventListener('DOMContentLoaded', init);

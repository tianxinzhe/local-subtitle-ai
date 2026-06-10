import { loadConfig, saveConfig, get } from '../modules/config.js';
import { i18n } from '../modules/i18n.js';
import { whisper } from '../modules/whisper.js';
import { translator, Translator } from '../modules/translator.js';
import { audioProcessor } from '../modules/audio-processor.js';
import { sentenceMerger } from '../modules/sentence-merger.js';
import { slidingWindow } from '../modules/sliding-window.js';
import { srtExporter } from '../modules/srt-exporter.js';
import { getAllLanguages, getLanguage, getLanguageDisplayName, isRtl } from '../modules/languages.js';
import { fileStore } from '../modules/file-store.js';

let backgroundPort = null;
let currentFile = null;
let currentFileType = null; // 'video', 'audio', 'subtitle'
let audioData = null;        // decoded Float32Array
let isProcessing = false;
let isAiReady = false;
let isCapturing = false;
let isExtracting = false;
let fullSpeedMode = false;
let captureStream = null;
let captureAudioContext = null;

const $ = (id) => document.getElementById(id);

// Yield to the browser so it can paint pending DOM/style changes before we
// run the next thread-blocking task (e.g. WASM Whisper inference). Two rAFs
// guarantee a paint has been committed, with a setTimeout fallback in case
// rAF is throttled (side panel backgrounded).
function nextPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 60);
  });
}

// Update the extraction progress bar + status label in one place.
function setExtractProgress(pct, statusText) {
  const fillEl = $('extractFill');
  if (fillEl) {
    fillEl.style.setProperty('width', pct + '%', 'important');
    fillEl.style.setProperty('display', 'block', 'important');
  }
  if (statusText !== undefined) {
    const statusEl = $('extractStatus');
    if (statusEl) statusEl.textContent = statusText;
  }
}

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
  populateEngineInfo();
}

async function populateEngineInfo() {
  const listEl = $('engineInfoList');
  if (!listEl) return;
  const engines = await Translator.getEnginesStatus();

  // After activation, update M2M100 detail with actual result
  const activeDetail = translator.getEngineDetail ? translator.getEngineDetail() : null;
  if (activeDetail) {
    for (const e of engines) {
      if (e.engine.includes('M2M100') && activeDetail.engine.includes('M2M100')) {
        e.available = activeDetail.available;
        e.detail = activeDetail.detail;
      }
    }
  }

  // Sort: available first
  engines.sort((a, b) => (a.available === b.available ? 0 : a.available ? -1 : 1));

  listEl.innerHTML = engines.map(e => {
    const ok = e.available;
    return `<div class="engine-info-item">
      <span class="engine-info-check ${ok ? 'ok' : 'fail'}">${ok ? '✓' : '✗'}</span>
      <div>
        <div class="engine-info-name">${e.engine}</div>
        <div class="engine-info-detail">${e.detail}</div>
      </div>
    </div>`;
  }).join('');
  $('engineInfo').classList.remove('hidden');
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

function updateLangToggle() {
  const lang = i18n.getCurrentLanguage();
  $('langToggle').value = lang;
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

  updateLangToggle();
}

function setModeCardsEnabled(enabled) {
  const cards = document.querySelectorAll('.mode-card');
  cards.forEach(c => c.classList.toggle('disabled', !enabled));
  $('captureBtn').disabled = !enabled;
}

function setupEventListeners() {
  $('activateBtn').addEventListener('click', toggleAi);

  $('langToggle').addEventListener('change', async (e) => {
    const lang = e.target.value;
    $('settingUiLang').value = lang;
    await i18n.setLanguage(lang);
    location.reload();
  });

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

  $('settingsPanel').addEventListener('click', (e) => {
    if (e.target === $('settingsPanel')) {
      $('settingsPanel').classList.add('hidden');
    }
  });

  $('downloadAudioBtn').addEventListener('click', downloadExtractedAudio);
  $('downloadSrtBtn').addEventListener('click', downloadExtractedSrt);
  $('downloadTranslatedBtn').addEventListener('click', downloadTranslatedSrt);

  $('stepAudioBtn').addEventListener('click', () => {
    if (currentFile && currentFileType === 'video' && !isExtracting) {
      extractAudio(currentFile);
    }
  });
  $('stepTranscribeBtn').addEventListener('click', () => {
    if (audioData && !isExtracting) {
      transcribeAudio();
    }
  });
  $('stepTranslateBtn').addEventListener('click', () => {
    if (srtExporter.getSegmentCount() > 0 && !isExtracting) {
      translateSubtitles();
    }
  });

  // Model picker confirm
  $('pickerConfirmBtn').addEventListener('click', () => {
    const selected = document.querySelector('input[name="pickerModel"]:checked');
    if (selected) {
      const model = selected.value;
      $('settingAsrModel').value = model;
      saveConfig({ asrModel: model });
      showModelPicker(false);
      doActivate(model);
    }
  });

  // Engine info toggle
  $('engineInfoToggle').addEventListener('click', () => {
    const body = $('engineInfoBody');
    const arrow = $('engineInfoToggle').querySelector('.engine-info-arrow');
    body.classList.toggle('hidden');
    arrow.classList.toggle('open');
  });
}

function showModelPicker(show) {
  $('modelPicker').classList.toggle('hidden', !show);
}

async function toggleAi() {
  if (isAiReady) return;

  // Show model picker before loading
  const config = await loadConfig();
  const currentModel = config.asrModel || 'tiny';
  const radio = document.querySelector(`input[name="pickerModel"][value="${currentModel}"]`);
  if (radio) radio.checked = true;
  showModelPicker(true);
}

async function doActivate(model) {
  if (isAiReady) return;

  const btn = $('activateBtn');
  const progressContainer = $('progressContainer');
  const progressFill = $('progressFill');
  const progressLabel = $('progressLabel');
  const whisperStatusEl = $('whisperStatus');
  const translatorStatusEl = $('translatorStatus');

  btn.disabled = true;
  progressContainer.classList.remove('hidden');

  let whisperOk = false, translatorOk = false;

  // Step 1: Load Whisper
  whisperStatusEl.textContent = '...';
  whisperStatusEl.className = 'model-status model-loading';
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Whisper: 0%';

  try {
    await whisper.load({
      model,
      onProgress: (pct, stage) => {
        progressFill.style.width = pct + '%';
        progressLabel.textContent = `Whisper: ${pct}%`;
        whisperStatusEl.textContent = `${pct}%`;
      },
    });
    whisperOk = true;
    whisperStatusEl.textContent = '✓ OK';
    whisperStatusEl.className = 'model-status model-ready';
  } catch (err) {
    whisperStatusEl.textContent = '✗ Failed';
    whisperStatusEl.className = 'model-status model-error';
    console.error('[SidePanel] Whisper load failed:', err);
  }

  // Step 2: Load Translator (even if whisper failed)
  translatorStatusEl.textContent = '...';
  translatorStatusEl.className = 'model-status model-loading';
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Translator: 0%';

  let finalStage = '';
  try {
    await translator.init({
      onProgress: (pct, stage) => {
        progressFill.style.width = pct + '%';
        // Show clean stage text without percentage (progress bar shows it visually)
        const displayStage = stage || `Translator: ${pct}%`;
        progressLabel.textContent = displayStage;
        if (pct < 100) {
          translatorStatusEl.textContent = displayStage;
        }
        if (pct >= 100) finalStage = stage;
      },
    });
    translatorOk = true;
    const badge = translator.getEngineDetail();
    if (badge && badge.engine.includes('M2M100')) {
      const dts = badge.detail.includes('q8') ? 'q8' : badge.detail.includes('fp16') ? 'fp16' : 'fp32';
      translatorStatusEl.textContent = `✓ M2M100-418M ${dts} (${badge.engine.match(/\d+ workers/)?.[0] || '?'})`;
    } else if (badge && badge.engine.includes('Gemini')) {
      translatorStatusEl.textContent = '✓ Gemini Nano ready';
    } else {
      translatorStatusEl.textContent = '✓ OK';
    }
    translatorStatusEl.className = 'model-status model-ready';
    populateEngineInfo();
  } catch (err) {
    translatorStatusEl.textContent = '✗ Failed';
    translatorStatusEl.className = 'model-status model-error';
    console.error('[SidePanel] Translator load failed:', err);
    populateEngineInfo();
  }

  // Done
  btn.disabled = false;
  progressContainer.classList.add('hidden');

  if (whisperOk) {
    isAiReady = true;
    setModeCardsEnabled(true);
  } else {
    progressLabel.textContent = 'Whisper failed — extraction disabled';
  }
}

function handleFileDrop(file) {
  console.log('[Step] handleFileDrop:', file.name, file.type, file.size);
  if (!isAiReady) {
    showToast('Please activate AI first');
    setStatus('error', 'Please activate AI first');
    return;
  }

  currentFile = file;
  audioData = null;
  srtExporter.clear();
  sentenceMerger.reset?.();
  $('subtitleList').innerHTML = '<div id="emptyState" class="empty-state">No subtitles yet</div>';
  $('subtitleCount').textContent = '0';

  // Detect file type
  const name = file.name.toLowerCase();
  const type = file.type;
  if (name.endsWith('.srt') || name.endsWith('.ass') || name.endsWith('.vtt')) {
    currentFileType = 'subtitle';
  } else if (type.startsWith('audio/') || name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.flac') || name.endsWith('.ogg') || name.endsWith('.m4a') || name.endsWith('.aac')) {
    currentFileType = 'audio';
  } else {
    currentFileType = 'video';
  }

  console.log('[Step] Detected type:', currentFileType);

  $('dropText').textContent = file.name;
  $('fileNameDisplay').textContent = file.name;
  $('fileTypeBadge').textContent = currentFileType.toUpperCase();
  $('fileInfo').classList.remove('hidden');
  $('stepActions').classList.remove('hidden');
  $('extractProgress').classList.add('hidden');
  $('extractDownloads').classList.add('hidden');
  $('modeLocal').classList.add('active');
  updateStepButtons();
  setStatus('ready', i18n.t('status_idle'));

  // For subtitle files, load content directly
  if (currentFileType === 'subtitle') {
    loadSubtitleFile(file);
  }
  // For audio files, decode audio immediately (skip step 1)
  if (currentFileType === 'audio') {
    decodeAudioOnly(file);
  }
}

function updateStepButtons() {
  const audioBtn = $('stepAudioBtn');
  const transcribeBtn = $('stepTranscribeBtn');
  const translateBtn = $('stepTranslateBtn');

  // Audio step: only for video files
  if (currentFileType === 'video') {
    audioBtn.className = audioData ? 'step-btn step-done' : 'step-btn';
    audioBtn.disabled = false;
  } else {
    audioBtn.className = 'step-btn step-done';
    audioBtn.disabled = true;
    $('stepAudioStatus').textContent = '✓';
  }

  // Transcribe step: needs audio data + Whisper
  if (audioData && whisper.isReady()) {
    transcribeBtn.className = srtExporter.getSegmentCount() > 0 ? 'step-btn step-done' : 'step-btn';
    transcribeBtn.disabled = false;
  } else if (currentFileType === 'subtitle') {
    transcribeBtn.className = 'step-btn step-done';
    transcribeBtn.disabled = true;
    $('stepTranscribeStatus').textContent = '✓';
  } else {
    transcribeBtn.className = 'step-btn step-disabled';
    transcribeBtn.disabled = true;
  }

  // Translate step: needs subtitles + Translator
  if (srtExporter.getSegmentCount() > 0 && hasTranslator()) {
    translateBtn.className = 'step-btn';
    translateBtn.disabled = false;
  } else {
    translateBtn.className = 'step-btn step-disabled';
    translateBtn.disabled = true;
  }
}

function hasTranslator() {
  return translator.isReady?.() || false;
}

async function decodeAudioOnly(file) {
  $('extractProgress').classList.remove('hidden');
  $('extractStatus').textContent = 'Decoding audio...';
  isExtracting = true;

  try {
    const raw = await audioProcessor.decodeAudioFile(file);
    audioData = raw;
    console.log('[Step] Audio decoded, amplitude:', getMaxAmplitude(raw).toFixed(6));
    $('extractProgress').classList.add('hidden');
    updateStepButtons();
  } catch (err) {
    console.error('[Step] Decode failed:', err);
    $('extractStatus').textContent = 'Decode failed: ' + err.message;
  }
  isExtracting = false;
}

async function loadSubtitleFile(file) {
  $('extractProgress').classList.remove('hidden');
  $('extractStatus').textContent = 'Loading subtitle file...';
  try {
    const text = await file.text();
    const lines = text.split('\n');
    // Simple SRT parse: look for timestamp patterns
    let currentSeg = null;
    for (let i = 0; i < lines.length; i++) {
      const tl = lines[i].trim();
      // Match timestamp line: 00:00:01,000 --> 00:00:04,000
      const tsMatch = tl.match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/);
      if (tsMatch) {
        currentSeg = {
          start: parseSrtTime(tsMatch[1]),
          end: parseSrtTime(tsMatch[2]),
          text: ''
        };
      } else if (tl && currentSeg && !/^\d+$/.test(tl)) {
        currentSeg.text += (currentSeg.text ? '\n' : '') + tl;
        if (i + 1 >= lines.length || lines[i + 1].trim() === '' || /^\d+$/.test(lines[i + 1].trim())) {
          srtExporter.addSegment({
            start: currentSeg.start,
            end: currentSeg.end,
            original: currentSeg.text.trim(),
            translation: '',
            detectedLanguage: null,
          });
          currentSeg = null;
        }
      }
    }
    $('subtitleList').innerHTML = '';
    for (const seg of srtExporter.getSegments()) {
      addSubtitleCard(seg.start, seg.original, '', false);
    }
    $('subtitleCount').textContent = srtExporter.getSegmentCount();
    updateExportButton();
    $('extractProgress').classList.add('hidden');
    $('extractDownloads').classList.remove('hidden');
    $('downloadSrtBtn').disabled = false;
    updateStepButtons();
  } catch (err) {
    console.error('[Step] Subtitle load failed:', err);
    $('extractStatus').textContent = 'Subtitle load failed: ' + err.message;
  }
}

function parseSrtTime(str) {
  const parts = str.replace(',', '.').split(':');
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

function getMaxAmplitude(arr) {
  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    const abs = Math.abs(arr[i]);
    if (abs > max) max = abs;
  }
  return max;
}

async function extractAudio(file) {
  console.log('[Step1] Starting audio extraction:', file.name);
  isExtracting = true;
  $('extractProgress').classList.remove('hidden');
  $('stepAudioBtn').className = 'step-btn step-active';
  $('stepAudioStatus').textContent = '...';
  setExtractProgress(0, 'Decoding audio...');

  try {
    const raw = await audioProcessor.decodeAudioFile(file);
    const maxA = getMaxAmplitude(raw);
    console.log('[Step1] Decoded, amplitude:', maxA.toFixed(6), 'samples:', raw.length);

    // Store clean audio for WAV export
    audioData = raw;

    setExtractProgress(100, 'Audio ready');
    $('stepAudioBtn').className = 'step-btn step-done';
    $('stepAudioStatus').textContent = '✓';
    $('extractDownloads').classList.remove('hidden');
    $('downloadAudioBtn').disabled = false;
    window._extractedAudioChunks = [raw];

    updateStepButtons();
  } catch (err) {
    console.error('[Step1] Failed:', err);
    $('extractStatus').textContent = 'Error: ' + err.message;
    $('stepAudioBtn').className = 'step-btn';
    $('stepAudioStatus').textContent = '✗';
  }
  isExtracting = false;
}

async function transcribeAudio() {
  if (!audioData) return;
  console.log('[Step2] Starting transcription');
  isExtracting = true;
  $('extractProgress').classList.remove('hidden');
  $('stepTranscribeBtn').className = 'step-btn step-active';
  $('stepTranscribeStatus').textContent = '...';

  // Clear previous subtitles
  srtExporter.clear();
  $('subtitleList').innerHTML = '<div id="emptyState" class="empty-state">No subtitles yet</div>';
  $('subtitleCount').textContent = '0';
  $('extractDownloads').classList.add('hidden');
  $('downloadSrtBtn').disabled = true;
  $('downloadTranslatedBtn').disabled = true;

  const config = await loadConfig();
  const sourceLang = config.sourceLanguage || 'auto';

  srtExporter.clear();
  $('subtitleList').innerHTML = '<div id="emptyState" class="empty-state">No subtitles yet</div>';
  $('subtitleCount').textContent = '0';

  try {
    const segments = await whisper.transcribeAll(audioData, {
      forceLanguage: sourceLang !== 'auto' ? sourceLang : null,
    }, (pct, msg) => {
      setExtractProgress(pct, msg);
      if (isExtracting === false) throw new Error('Cancelled');
    });

    if (!isExtracting) return;

    let added = 0;
    $('extractDownloads').classList.remove('hidden');
    $('downloadSrtBtn').disabled = false;

    for (const seg of segments) {
      if (!seg.text || !seg.text.trim()) continue;
      srtExporter.addSegment({
        start: seg.start,
        end: seg.end,
        original: seg.text.trim(),
        translation: '',
        detectedLanguage: seg.detectedLanguage,
      });
      addSubtitleCard(seg.start, seg.text.trim(), '', isRtl(seg.detectedLanguage));
      added++;
    }

    console.log('[Step2] Done, segments:', added);
    setExtractProgress(100, `Transcribed ${added} segments`);
  } catch (e) {
    if (e.message === 'Cancelled') {
      console.log('[Step2] Cancelled');
    } else {
      console.error('[Step2] Failed:', e);
      setExtractProgress(0, 'Error');
    }
  }
  $('stepTranscribeBtn').className = 'step-btn step-done';
  $('stepTranscribeStatus').textContent = '✓';
  updateExportButton();
  updateStepButtons();
  isExtracting = false;
}

async function translateSubtitles() {
  const segments = srtExporter.getSegments();
  if (!segments || segments.length === 0) return;
  console.log('[Step3] Starting translation, segments:', segments.length);
  isExtracting = true;
  $('extractProgress').classList.remove('hidden');
  $('stepTranslateBtn').className = 'step-btn step-active';
  $('stepTranslateStatus').textContent = '...';

  const config = await loadConfig();
  const targetLang = config.targetLanguage || 'zh';
  const sourceLang = config.sourceLanguage || 'auto';
  const effectiveSource = sourceLang !== 'auto'
    ? sourceLang
    : (segments[0].detectedLanguage || targetLang === 'zh' ? 'en' : 'zh');

  const engine = translator.getEngine?.() || '?';
  const engineLabel = engine === 'gemini-nano' ? 'Gemini Nano' : 'M2M100-418M';
  setExtractProgress(0, `[${engineLabel}] Translating 0/${segments.length}`);
  console.log(`[Step3] Engine: ${engine}, source=${effectiveSource}, target=${targetLang}, translating ${segments.length} segments`);

  const translated = await translator.batchTranslate(
    segments,
    effectiveSource,
    targetLang,
    (pct) => {
      setExtractProgress(pct, `Translating... ${pct}%`);
    }
  );

  let translatedCount = 0;
  for (const seg of translated) {
    if (seg.translation) translatedCount++;
  }

  // Refresh UI cards to show translations
  const list = $('subtitleList');
  list.innerHTML = '';
  for (const seg of translated) {
    const rtl = isRtl(seg.detectedLanguage) || isRtl(targetLang);
    addSubtitleCard(seg.start, seg.original, seg.translation, rtl);
  }

  // Write translated segments back to srtExporter
  srtExporter.clear();
  srtExporter.addSegments(translated);

  // Verify writeback
  const writtenSegs = srtExporter.getSegments();
  const withTr = writtenSegs.filter(s => s.translation).length;
  console.log(`[Step3] Writeback verified: ${writtenSegs.length} segs, ${withTr} with translation`);
  console.log('[Step3] First 3 after writeback:', writtenSegs.slice(0, 3).map(s => ({ idx: s.index, tr: (s.translation || '').substring(0, 40) })));

  console.log('[Step3] Done, translated:', translatedCount);
  setExtractProgress(100, `Translated ${translatedCount} segments`);
  $('stepTranslateBtn').className = 'step-btn step-done';
  $('stepTranslateStatus').textContent = '✓';
  $('downloadTranslatedBtn').disabled = false;
  $('extractDownloads').classList.remove('hidden');
  updateExportButton();
  isExtracting = false;
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
  if (!window._extractedAudioChunks || window._extractedAudioChunks.length === 0) {
    showToast('No extracted audio data available');
    return;
  }
  const totalLen = window._extractedAudioChunks.reduce((s, c) => s + c.length, 0);
  const combined = new Float32Array(totalLen);
  let offset = 0;
  for (const c of window._extractedAudioChunks) {
    combined.set(c, offset);
    offset += c.length;
  }

  // Measure peak amplitude.
  let maxAbs = 0;
  for (let i = 0; i < combined.length; i++) {
    const abs = Math.abs(combined[i]);
    if (abs > maxAbs) maxAbs = abs;
  }
  console.log('[Download] WAV raw max amplitude:', maxAbs.toFixed(6), 'samples:', combined.length);

  // Simple, non-destructive peak normalization to -1 dBFS (~0.89). We do NOT
  // apply a noise gate here: the previous gate zeroed every sample below
  // RMS*0.3, which mangled the speech waveform and produced silent/garbled
  // exports. We only scale the whole signal uniformly so it stays faithful
  // to the source audio. Skip if already near full scale or effectively
  // silent.
  if (maxAbs > 0.000001 && maxAbs < 0.89) {
    const gain = 0.89 / maxAbs;
    for (let i = 0; i < combined.length; i++) combined[i] *= gain;
    console.log('[Download] Applied normalization gain:', gain.toFixed(2), '-> peak ~0.89');
  } else {
    console.log('[Download] No normalization applied (peak already', maxAbs.toFixed(4) + ')');
  }

  const blob = float32ToWavBlob(combined, 16000);
  const url = URL.createObjectURL(blob);
  const name = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') + '_audio.wav' : 'extracted_audio.wav';
  chrome.downloads.download({ url, filename: name, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error('[SidePanel] Download failed:', chrome.runtime.lastError.message);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  });
}

function downloadExtractedSrt() {
  if (srtExporter.getSegmentCount() === 0) {
    showToast('No subtitles to export');
    return;
  }
  const content = srtExporter.exportOriginalOnly();
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/srt;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const name = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') + '_original.srt' : 'subtitles_original.srt';
  chrome.downloads.download({ url, filename: name, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error('[SidePanel] Download failed:', chrome.runtime.lastError.message);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  });
}

function downloadTranslatedSrt() {
  if (srtExporter.getSegmentCount() === 0) {
    showToast('No translated subtitles to export');
    return;
  }
  const content = srtExporter.exportBilingual();
  console.log('[Download] exportBilingual first 500 chars:', content.substring(0, 500));
  console.log('[Download] segments:', srtExporter.getSegments().slice(0, 5).map(s => ({ i: s.index, orig: s.original.substring(0, 30), tr: (s.translation || '').substring(0, 30) })));
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/srt;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const name = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') + '_bilingual.srt' : 'subtitles_bilingual.srt';
  chrome.downloads.download({ url, filename: name, saveAs: true }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error('[SidePanel] Download failed:', chrome.runtime.lastError.message);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  });
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
  console.log('[Status]', type, text);
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

import { loadConfig, saveConfig, get } from '../modules/config.js';
import { i18n } from '../modules/i18n.js';
import { whisper, MODEL_REPO, MODEL_VERSION } from '../modules/whisper.js';
import { translator, Translator } from '../modules/translator.js';
import { audioProcessor } from '../modules/audio-processor.js';
import { sentenceMerger } from '../modules/sentence-merger.js';
import { slidingWindow } from '../modules/sliding-window.js';
import { srtExporter } from '../modules/srt-exporter.js';
import { getAllLanguages, getLanguage, getLanguageDisplayName, isRtl } from '../modules/languages.js';
import * as Cache from '../modules/indexeddb-cache.js';

let currentFile = null;
let currentFileType = null; // 'video', 'audio', 'subtitle'
let audioData = null;        // decoded Float32Array
let isProcessing = false;
let isAiReady = false;
let isExtracting = false;
let _currentStep = null; // 'Extract' | 'Transcribe' | 'Translate'

// Whisper initial-prompt presets. Whisper uses the prompt as preceding
// context to bias recognition toward domain terminology, proper nouns,
// and speaking style. Keep these short (< ~200 tokens) and lowercase
// punctuation is fine — Whisper handles mixed casing.
const PROMPT_PRESETS = {
  general: '',
  tech: 'Discussion covers software engineering, machine learning, neural networks, transformers, large language models, APIs, databases, cloud infrastructure, distributed systems, algorithms, Python, JavaScript, GPU, CUDA, quantization, fine-tuning, inference, embeddings, vector databases, RAG, agents.',
  medical: 'Clinical discussion covers patient history, diagnosis, symptoms, treatment, medication, dosage, surgery, anesthesia, cardiology, oncology, pathology, radiology, MRI, CT scan, blood pressure, laboratory results, prognosis, follow-up care.',
  legal: 'Court proceedings and legal discussion involving attorneys, witnesses, defendants, plaintiffs, evidence, objections, testimony, cross-examination, ruling, motion, deposition, contract, liability, statute, jurisdiction, precedent, verdict.',
  finance: 'Financial markets discussion covering stocks, bonds, equities, derivatives, options, futures, Forex, cryptocurrency, Bitcoin, Ethereum, central bank, Federal Reserve, interest rates, inflation, GDP, earnings, P/E ratio, market cap, portfolio, hedge fund, asset allocation.',
  education: 'Lecture and educational content with clear explanations of concepts, definitions, theorems, examples, exercises, homework, students, professor, syllabus, curriculum, mathematics, physics, chemistry, biology, history, philosophy.',
  interview: 'Podcast interview with guest introduction, personal background, career journey, opinions, anecdotes, advice, follow-up questions, conversational tone, laughter, pauses, thank you for joining us today.',
  gaming: 'Gaming livestream and commentary covering gameplay, walkthrough, strategy, speedrun, boss fight, multiplayer, FPS, RPG, MOBA, console, PC, Steam, DLC, patch notes, meta, build, loadout, kill death ratio.',
};

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
function setExtractProgress(pct, statusText, opts) {
  const ppFill = $('ppFill');
  if (ppFill) ppFill.style.width = Math.round(pct) + '%';
  if (_currentStep) {
    const progEl = $('prog' + _currentStep);
    if (progEl && pct < 100) {
      progEl.innerHTML = `<span class="step-spinner"></span> ${Math.round(pct)}%`;
    }
  }
}

function setStepDone(step, ok) {
  const progEl = $('prog' + step);
  const dlEl = $('dl' + step);
  if (ok) {
    progEl.textContent = '✓';
    progEl.className = 'si-progress si-done';
    dlEl.classList.remove('hidden');
  } else {
    progEl.textContent = '✗';
    progEl.className = 'si-progress si-error';
  }
}

function updatePipelineCheckboxes(fileType) {
  const chkExtract = $('chkExtract');
  const chkTranscribe = $('chkTranscribe');
  const chkTranslate = $('chkTranslate');
  if (fileType === 'video') {
    chkExtract.checked = true; chkExtract.disabled = false; chkExtract.parentElement.classList.remove('pl-disabled');
    chkTranscribe.checked = true; chkTranscribe.disabled = false; chkTranscribe.parentElement.classList.remove('pl-disabled');
    chkTranslate.checked = true; chkTranslate.disabled = false; chkTranslate.parentElement.classList.remove('pl-disabled');
  } else if (fileType === 'audio') {
    chkExtract.checked = true; chkExtract.disabled = true; chkExtract.parentElement.classList.add('pl-disabled');
    chkTranscribe.checked = true; chkTranscribe.disabled = false; chkTranscribe.parentElement.classList.remove('pl-disabled');
    chkTranslate.checked = true; chkTranslate.disabled = false; chkTranslate.parentElement.classList.remove('pl-disabled');
  } else if (fileType === 'subtitle') {
    chkExtract.checked = false; chkExtract.disabled = true; chkExtract.parentElement.classList.add('pl-disabled');
    chkTranscribe.checked = false; chkTranscribe.disabled = true; chkTranscribe.parentElement.classList.add('pl-disabled');
    chkTranslate.checked = true; chkTranslate.disabled = false; chkTranslate.parentElement.classList.remove('pl-disabled');
  }
}

function resetPipelineSteps() {
  $('stepList').classList.add('hidden');
  $('ppWrap').classList.add('hidden');
  for (const s of ['Extract', 'Transcribe', 'Translate']) {
    const p = $('prog' + s);
    p.textContent = '';
    p.className = 'si-progress';
    $('dl' + s).classList.add('hidden');
  }
}

async function executePipeline() {
  if (isProcessing) return;
  isProcessing = true;
  $('executeBtn').disabled = true;
  $('stepList').classList.remove('hidden');
  $('ppWrap').classList.remove('hidden');
  $('ppFill').style.width = '0%';

  const doExtract = $('chkExtract').checked && !$('chkExtract').disabled;
  const doTranscribe = $('chkTranscribe').checked && !$('chkTranscribe').disabled;
  const doTranslate = $('chkTranslate').checked && !$('chkTranslate').disabled;

  for (const s of ['Extract', 'Transcribe', 'Translate']) {
    const show = (s === 'Extract' && doExtract) || (s === 'Transcribe' && doTranscribe) || (s === 'Translate' && doTranslate);
    $('si' + s).classList.toggle('hidden', !show);
    if (show) {
      $('prog' + s).textContent = '⏳';
      $('prog' + s).className = 'si-progress';
      $('dl' + s).classList.add('hidden');
    }
  }

  try {
    if (doExtract && currentFileType === 'video' && !audioData) {
      _currentStep = 'Extract';
      await extractAudio(currentFile);
      setStepDone('Extract', true);
    } else {
      $('siExtract').classList.add('hidden');
    }

    if (doTranscribe && audioData) {
      _currentStep = 'Transcribe';
      await transcribeAudio();
      setStepDone('Transcribe', true);
    } else if (currentFileType === 'subtitle') {
      setStepDone('Transcribe', true);
    } else {
      $('siTranscribe').classList.add('hidden');
    }

    if (doTranslate && srtExporter.getSegmentCount() > 0 && hasTranslator()) {
      _currentStep = 'Translate';
      await translateSubtitles();
      setStepDone('Translate', true);
    } else {
      $('siTranslate').classList.add('hidden');
    }
  } catch (err) {
    console.error('[Pipeline] Failed:', err);
    if (_currentStep) setStepDone(_currentStep, false);
  }

  _currentStep = null;
  isProcessing = false;
  $('executeBtn').disabled = false;
}

function localizeHtml() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = i18n.t(el.getAttribute('data-i18n'));
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = i18n.t(el.getAttribute('data-i18n-title'));
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = i18n.t(el.getAttribute('data-i18n-placeholder'));
  }
  document.documentElement.lang = i18n.getCurrentLanguage();
}

async function init() {
  await i18n.init();
  localizeHtml();
  await populateLanguageDropdowns();
  await loadSettings();
  setupEventListeners();
  setModeCardsEnabled(false);
}

async function populateEngineInfo() {
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

  $('asrModelSelect').value = config.asrModel || 'base';
  $('engineSelect').value = config.translationEngine || 'auto';

  // Load saved prompts into selector
  await loadPromptDropdown($('promptPreset'), config.activePromptId);

  updateLangToggle();
  loadModelCacheList();
  loadPromptManager();
}

const MODEL_LABELS = {
  tiny: 'option_tiny_model',
  base: 'option_base_model',
  small: 'option_small_model',
  medium: 'option_medium_model',
  'large-v3': 'option_large_v3_model',
  'm2m100': 'model_cache_m2m100',
};

function formatMB(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function getCacheSizeForModel(modelKey) {
  let bytes = 0;
  try {
    const cacheNames = await caches.keys();
    const repoId = modelKey === 'm2m100' ? 'Xenova/m2m100_418M' : MODEL_REPO[modelKey];
    if (!repoId) return 0;
    for (const name of cacheNames) {
      try {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          const url = req.url || '';
          if (url.includes(repoId)) {
            const resp = await cache.match(url);
            if (resp) {
              const blob = await resp.clone().blob();
              bytes += blob.size;
            }
          }
        }
      } catch {}
    }
  } catch {}
  return bytes;
}

async function loadModelCacheList() {
  const list = $('modelCacheList');
  if (!list) return;
  list.innerHTML = '';

  const whisperKeys = Object.keys(MODEL_REPO);
  const rows = [];

  for (const key of whisperKeys) {
    const meta = await Cache.getModelConfig(`whisper_${key}`);
    const cached = !!(meta && meta.version === MODEL_VERSION[key]);
    const size = cached ? await getCacheSizeForModel(key) : 0;
    rows.push({ key, labelKey: MODEL_LABELS[key], cached, size, cachedAt: meta?.cachedAt });
  }

  // M2M100
  const m2mMeta = await Cache.getModelConfig('m2m100_418M');
  const m2mCached = !!m2mMeta;
  const m2mSize = m2mCached ? await getCacheSizeForModel('m2m100') : 0;
  rows.push({ key: 'm2m100', labelKey: MODEL_LABELS.m2m100, cached: m2mCached, size: m2mSize, cachedAt: m2mMeta?.cachedAt });

  let total = 0;
  for (const r of rows) {
    total += r.size;
    const row = document.createElement('div');
    row.className = 'cache-row' + (r.cached ? ' cached' : '');
    const label = i18n.t(r.labelKey) || r.key;
    const status = r.cached
      ? `<span class="cache-status cached" data-i18n="model_cache_status_cached">${i18n.t('model_cache_status_cached')}</span>`
      : `<span class="cache-status not-cached" data-i18n="model_cache_status_not_cached">${i18n.t('model_cache_status_not_cached')}</span>`;
    const sizeText = r.cached ? formatMB(r.size) : '';
    const dateText = r.cached && r.cachedAt
      ? new Date(r.cachedAt).toLocaleDateString()
      : '';
    row.innerHTML = `
      <div class="cache-row-name">${label}</div>
      <div class="cache-row-meta">${status}${sizeText ? ` · <span class="cache-size">${sizeText}</span>` : ''}${dateText ? ` · <span class="cache-date">${dateText}</span>` : ''}</div>
    `;
    list.appendChild(row);
  }

  $('modelCacheTotal').textContent = i18n.t('model_cache_total', { size: formatMB(total) });
}

async function clearModelCache() {
  if (!confirm(i18n.t('model_cache_clear_confirm'))) return;

  // Unload active models first
  try { await whisper.unload(); } catch {}
  try { await translator.unload(); } catch {}

  // Clear IndexedDB model stores
  try { await Cache.clearModelCache(); } catch (e) { console.warn('IDB clear:', e); }

  // Remove all model files from CacheStorage
  try {
    const names = await caches.keys();
    await Promise.all(names.map(async (name) => {
      try {
        const cache = await caches.open(name);
        const reqs = await cache.keys();
        await Promise.all(reqs.map(r => cache.delete(r)));
      } catch {}
    }));
  } catch (e) { console.warn('CacheStorage clear:', e); }

  showToast(i18n.t('model_cache_cleared'));
  isAiReady = false;
  setModeCardsEnabled(false);
  $('activateBtn').classList.remove('hidden');
  $('reactivateBtn').classList.add('hidden');
  await loadModelCacheList();
}

function setModeCardsEnabled(enabled) {
  const cards = document.querySelectorAll('.mode-card');
  cards.forEach(c => c.classList.toggle('disabled', !enabled));
}

// ── Prompt Management ──
const PROMPT_STORAGE_KEY = 'whisperPrompts';

async function loadPrompts() {
  const result = await chrome.storage.local.get(PROMPT_STORAGE_KEY);
  return result[PROMPT_STORAGE_KEY] || [];
}

async function savePrompts(prompts) {
  await chrome.storage.local.set({ [PROMPT_STORAGE_KEY]: prompts });
}

async function setActivePrompt(id) {
  await saveConfig({ activePromptId: id });
  // Update the text shown in workbench
  const prompts = await loadPrompts();
  const prompt = prompts.find(p => p.id === id);
  $('promptCustom').value = prompt ? prompt.text : '';
}

async function loadPromptDropdown(selectEl, activeId) {
  const prompts = await loadPrompts();
  selectEl.innerHTML = '<option value="">' + i18n.t('prompt_none') + '</option>';
  for (const p of prompts) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeId) opt.selected = true;
    selectEl.appendChild(opt);
  }
  // Show the selected prompt text
  const active = prompts.find(p => p.id === activeId);
  $('promptCustom').value = active ? active.text : '';
}

async function loadPromptManager() {
  const list = $('promptList');
  if (!list) return;
  list.innerHTML = '';
  const prompts = await loadPrompts();
  for (const p of prompts) {
    const item = document.createElement('div');
    item.className = 'prompt-item';
    item.innerHTML = `
      <div class="prompt-item-header">
        <span class="prompt-item-name">${escapeHtml(p.name)}</span>
        <div class="prompt-item-actions">
          <button class="del-btn" data-id="${p.id}">${i18n.t('model_cache_clear_confirm').includes('Delete') ? 'Delete' : '删除'}</button>
        </div>
      </div>
      <div class="prompt-item-text">${escapeHtml(p.text)}</div>
    `;
    item.querySelector('.del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deletePrompt(p.id);
    });
    item.addEventListener('click', () => {
      item.classList.toggle('expanded');
      // Load into workbench editor for quick editing
      const select = $('promptPreset');
      for (const opt of select.options) {
        if (opt.value === p.id) opt.selected = true;
      }
      $('promptCustom').value = p.text;
      setActivePrompt(p.id);
    });
    list.appendChild(item);
  }
}

async function addPrompt(name, text) {
  if (!name.trim() || !text.trim()) return;
  const prompts = await loadPrompts();
  const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  prompts.push({ id, name: name.trim(), text: text.trim() });
  await savePrompts(prompts);
  await loadPromptManager();
  await loadPromptDropdown($('promptPreset'), id);
  await setActivePrompt(id);
  $('promptNewName').value = '';
  $('promptNewText').value = '';
}

async function deletePrompt(id) {
  let prompts = await loadPrompts();
  prompts = prompts.filter(p => p.id !== id);
  await savePrompts(prompts);
  await loadPromptManager();
  const config = await loadConfig();
  if (config.activePromptId === id) {
    await setActivePrompt('');
  }
  await loadPromptDropdown($('promptPreset'), config.activePromptId === id ? '' : config.activePromptId);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setupEventListeners() {
  $('activateBtn').addEventListener('click', toggleAi);
  $('reactivateBtn').addEventListener('click', reactivateAi);

  $('langToggle').addEventListener('change', async (e) => {
    const lang = e.target.value;
    await i18n.setLanguage(lang);
    localizeHtml();
    await populateLanguageDropdowns();
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

  $('sourceLang').addEventListener('change', async () => {
    await saveConfig({ sourceLanguage: $('sourceLang').value });
  });

  $('targetLang').addEventListener('change', async () => {
    await saveConfig({ targetLanguage: $('targetLang').value });
  });

  // Whisper prompt (select from saved)
  $('promptToggle').addEventListener('click', () => {
    const body = $('promptBody');
    const section = $('promptToggle').parentElement;
    body.classList.toggle('hidden');
    section.classList.toggle('open', !body.classList.contains('hidden'));
  });

  $('promptPreset').addEventListener('change', async () => {
    const id = $('promptPreset').value;
    const prompts = await loadPrompts();
    const prompt = prompts.find(p => p.id === id);
    $('promptCustom').value = prompt ? prompt.text : '';
    await setActivePrompt(id);
  });

  $('promptCustom').addEventListener('input', async () => {
    const id = $('promptPreset').value;
    if (id) {
      const prompts = await loadPrompts();
      const idx = prompts.findIndex(p => p.id === id);
      if (idx >= 0) {
        prompts[idx].text = $('promptCustom').value;
        await savePrompts(prompts);
      }
    }
  });

  $('exportBtn').addEventListener('click', exportSrt);

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      const tab = document.getElementById('tab' + btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1));
      if (tab) tab.classList.add('active');
    });
  });

  $('asrModelSelect').addEventListener('change', async () => {
    await saveConfig({ asrModel: $('asrModelSelect').value });
  });

  $('engineSelect').addEventListener('change', async () => {
    await saveConfig({ translationEngine: $('engineSelect').value });
  });

  $('clearModelCacheBtn').addEventListener('click', clearModelCache);

  // Settings section toggles
  document.querySelectorAll('.settings-toggle').forEach(el => {
    const body = document.getElementById(el.dataset.target);
    const section = el.parentElement;
    // Start expanded
    section.classList.add('open');
    body.classList.remove('hidden');
    el.addEventListener('click', () => {
      body.classList.toggle('hidden');
      section.classList.toggle('open', !body.classList.contains('hidden'));
    });
  });

  $('promptAddBtn').addEventListener('click', async () => {
    const name = $('promptNewName').value.trim();
    const text = $('promptNewText').value.trim();
    if (name && text) await addPrompt(name, text);
  });
  $('promptNewName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('promptAddBtn').click();
  });

  // Pipeline execute + download buttons
  $('executeBtn').addEventListener('click', executePipeline);
  $('dlExtract').addEventListener('click', downloadExtractedAudio);
  $('dlTranscribe').addEventListener('click', downloadExtractedSrt);
  $('dlTranslate').addEventListener('click', downloadTranslatedSrt);
}

async function toggleAi() {
  if (isAiReady) return;
  const model = $('asrModelSelect').value;
  await doActivate(model);
}

async function reactivateAi() {
  if (!isAiReady) return;
  isAiReady = false;
  setModeCardsEnabled(false);
  $('activateBtn').classList.add('hidden');
  $('reactivateBtn').disabled = true;
  $('reactivateBtn').classList.add('processing');

  const whisperStatusEl = $('whisperStatus');
  const translatorStatusEl = $('translatorStatus');
  whisperStatusEl.textContent = 'unloading';
  whisperStatusEl.className = 'sel-status sel-loading';
  translatorStatusEl.textContent = 'unloading';
  translatorStatusEl.className = 'sel-status sel-loading';

  try {
    await Promise.allSettled([whisper.unload(), translator.unload()]);
  } catch (err) {
    console.warn('[SidePanel] unload error:', err);
  }

  slidingWindow.clear();

  const model = $('asrModelSelect').value;
  await doActivate(model);
}

async function doActivate(model) {
  if (isAiReady) return;

  const btn = $('activateBtn');
  const progressContainer = $('progressContainer');
  const progressLabel = $('progressLabel');
  const workerList = $('workerProgressList');
  const whisperStatusEl = $('whisperStatus');
  const translatorStatusEl = $('translatorStatus');

  btn.disabled = true;
  progressContainer.classList.remove('hidden');

  let whisperOk = false, translatorOk = false;

  // Step 1: Load Whisper
  whisperStatusEl.textContent = '...';
  whisperStatusEl.className = 'sel-status sel-loading';
  progressLabel.textContent = 'Whisper: loading...';

  try {
    await whisper.load({
      model,
      onProgress: (pct, stage, workerIdx) => {
        // Init call: create worker progress bars
        if (pct === -1 && stage === 'init' && typeof workerIdx === 'number') {
          workerList.innerHTML = '';
          for (let i = 0; i < workerIdx; i++) {
            const row = document.createElement('div');
            row.className = 'worker-progress-row';
            row.innerHTML = `
              <span class="worker-label">W${i + 1}</span>
              <div class="worker-bar-wrap"><div class="worker-bar-fill" data-w="${i}"></div></div>
            `;
            workerList.appendChild(row);
          }
          return;
        }
        if (workerIdx !== undefined && workerIdx >= 0) {
          const bar = workerList.querySelector(`.worker-bar-fill[data-w="${workerIdx}"]`);
          if (bar) {
            bar.style.width = pct + '%';
            bar.classList.toggle('done', pct >= 100);
          }
        }
        // Compute overall average for status label
        const fills = workerList.querySelectorAll('.worker-bar-fill');
        let sum = 0;
        for (const f of fills) sum += parseFloat(f.style.width) || 0;
        const avg = fills.length > 0 ? Math.round(sum / fills.length) : pct;
        progressLabel.textContent = `Whisper: ${avg}%`;
        whisperStatusEl.textContent = `${avg}%`;
      },
    });
    whisperOk = true;
    whisperStatusEl.textContent = '✓ OK';
    whisperStatusEl.className = 'sel-status sel-ready';
  } catch (err) {
    whisperStatusEl.textContent = '✗ Failed';
    whisperStatusEl.className = 'sel-status sel-error';
    console.error('[SidePanel] Whisper load failed:', err);
  }

  // Clear worker bars before translator phase
  workerList.innerHTML = '';

  // Step 2: Load Translator (even if whisper failed)
  translatorStatusEl.textContent = '...';
  translatorStatusEl.className = 'sel-status sel-loading';
  progressLabel.textContent = 'Translator: 0%';

  let finalStage = '';
  const configForEngine = await loadConfig();
  const enginePref = configForEngine.translationEngine || 'auto';
  try {
    // Show single progress bar for translator
    workerList.innerHTML = '<div class="worker-progress-row"><div class="worker-bar-wrap" style="flex:1;margin-left:0"><div class="worker-bar-fill" id="tlFill"></div></div></div>';
    await translator.init({
      enginePreference: enginePref,
      onProgress: (pct, stage) => {
        const tlFill = $('tlFill');
        if (tlFill) tlFill.style.width = pct + '%';
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
    translatorStatusEl.className = 'sel-status sel-ready';
    populateEngineInfo();
  } catch (err) {
    translatorStatusEl.textContent = '✗ Failed';
    translatorStatusEl.className = 'sel-status sel-error';
    console.error('[SidePanel] Translator load failed:', err);
    populateEngineInfo();
  }

  // Done
  btn.disabled = false;
  progressContainer.classList.add('hidden');

  if (whisperOk) {
    isAiReady = true;
    setModeCardsEnabled(true);
    $('activateBtn').classList.add('hidden');
    $('reactivateBtn').classList.remove('hidden');
    $('reactivateBtn').disabled = false;
    $('reactivateBtn').classList.remove('processing');
    loadModelCacheList();
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
  $('pipelineArea').classList.remove('hidden');
  resetPipelineSteps();
  updatePipelineCheckboxes(currentFileType);
  $('executeBtn').disabled = false;
  $('modeLocal').classList.add('active');
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

function hasTranslator() {
  return translator.isReady?.() || false;
}

async function decodeAudioOnly(file) {
  isExtracting = true;

  try {
    const raw = await audioProcessor.decodeAudioFile(file, {
      onLog: (msg) => console.log('[AudioProcessor]', msg),
    });
    audioData = raw;
    console.log('[Step] Audio decoded, amplitude:', getMaxAmplitude(raw).toFixed(6));
  } catch (err) {
    console.error('[Step] Decode failed:', err);
  }
  isExtracting = false;
}

async function loadSubtitleFile(file) {
  try {
    const text = await file.text();
    const lines = text.split('\n');
    let currentSeg = null;
    for (let i = 0; i < lines.length; i++) {
      const tl = lines[i].trim();
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
  } catch (err) {
    console.error('[Step] Subtitle load failed:', err);
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
  setExtractProgress(0, 'Decoding audio...');

  try {
    const raw = await audioProcessor.decodeAudioFile(file, {
      onLog: (msg) => console.log('[AudioProcessor]', msg),
    });
    const maxA = getMaxAmplitude(raw);
    console.log('[Step1] Decoded, amplitude:', maxA.toFixed(6), 'samples:', raw.length);

    audioData = raw;

    setExtractProgress(100, 'Audio ready');
    window._extractedAudioChunks = [raw];
  } catch (err) {
    console.error('[Step1] Failed:', err);
    throw err;
  }
  isExtracting = false;
}

async function transcribeAudio() {
  if (!audioData) return;
  console.log('[Step2] Starting transcription');
  isExtracting = true;

  srtExporter.clear();
  $('subtitleList').innerHTML = '<div id="emptyState" class="empty-state">No subtitles yet</div>';
  $('subtitleCount').textContent = '0';

  const config = await loadConfig();
  const sourceLang = config.sourceLanguage || 'auto';
  const prompts = await loadPrompts();
  const activePrompt = config.activePromptId ? prompts.find(p => p.id === config.activePromptId) : null;
  const whisperPrompt = activePrompt ? activePrompt.text : '';

  try {
    const segments = await whisper.transcribeAll(audioData, {
      forceLanguage: sourceLang !== 'auto' ? sourceLang : null,
      prompt: whisperPrompt || undefined,
    }, (pct, msg) => {
      setExtractProgress(pct, msg);
      if (isExtracting === false) throw new Error('Cancelled');
    });

    if (!isExtracting) return;

    let added = 0;

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
    }
  }
  updateExportButton();
  isExtracting = false;
}

async function translateSubtitles() {
  const segments = srtExporter.getSegments();
  if (!segments || segments.length === 0) return;
  console.log('[Step3] Starting translation, segments:', segments.length);
  isExtracting = true;

  const config = await loadConfig();
  const targetLang = config.targetLanguage || 'zh';
  const sourceLang = config.sourceLanguage || 'auto';
  const effectiveSource = sourceLang !== 'auto'
    ? sourceLang
    : (segments[0].detectedLanguage || (targetLang === 'zh' ? 'en' : 'zh'));

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

  const list = $('subtitleList');
  list.innerHTML = '';
  for (const seg of translated) {
    const rtl = isRtl(seg.detectedLanguage) || isRtl(targetLang);
    addSubtitleCard(seg.start, seg.original, seg.translation, rtl);
  }

  srtExporter.clear();
  srtExporter.addSegments(translated);

  const writtenSegs = srtExporter.getSegments();
  const withTr = writtenSegs.filter(s => s.translation).length;
  console.log(`[Step3] Writeback verified: ${writtenSegs.length} segs, ${withTr} with translation`);

  console.log('[Step3] Done, translated:', translatedCount);
  setExtractProgress(100, `Translated ${translatedCount} segments`);
  updateExportButton();
  isExtracting = false;
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

  const bilingual = config.exportBilingual !== false;
  const lang = bilingual ? (config.targetLanguage || 'zh') : (config.sourceLanguage || 'auto');
  const base = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'subtitles';
  const filename = `${base}.${lang}.srt`;

  try {
    await srtExporter.download(
      bilingual,
      config.sourceLanguage,
      config.targetLanguage,
      filename
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

async function downloadExtractedSrt() {
  if (srtExporter.getSegmentCount() === 0) {
    showToast('No subtitles to export');
    return;
  }
  const config = await loadConfig();
  const content = srtExporter.exportOriginalOnly();
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/srt;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const lang = config.sourceLanguage || 'auto';
  const base = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'subtitles';
  const name = `${base}.${lang}.srt`;
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

async function downloadTranslatedSrt() {
  if (srtExporter.getSegmentCount() === 0) {
    showToast('No translated subtitles to export');
    return;
  }
  const config = await loadConfig();
  const content = srtExporter.exportBilingual();
  console.log('[Download] exportBilingual first 500 chars:', content.substring(0, 500));
  console.log('[Download] segments:', srtExporter.getSegments().slice(0, 5).map(s => ({ i: s.index, orig: s.original.substring(0, 30), tr: (s.translation || '').substring(0, 30) })));
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/srt;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const lang = config.targetLanguage || 'zh';
  const base = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'subtitles';
  const name = `${base}.${lang}.srt`;
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

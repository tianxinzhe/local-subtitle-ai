import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

let _ffmpeg = null;
let _loading = null;

function coreURL(file) {
  return chrome.runtime.getURL('libs/ffmpeg/' + file);
}

async function getFFmpeg(onProgress) {
  if (_ffmpeg) return _ffmpeg;
  if (_loading) return _loading;

  _loading = (async () => {
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => {
      console.log('[ffmpeg]', message);
    });
    ff.on('progress', ({ progress }) => {
      if (onProgress) onProgress(Math.min(100, Math.round(progress * 100)), 'progress');
    });

    const coreJs = coreURL('ffmpeg-core.js');
    const coreWasm = coreURL('ffmpeg-core.wasm');
    console.log('[ffmpeg] loading core:', coreJs, coreWasm);

    // Verify the core URL is reachable from the main thread before passing to worker
    try {
      const head = await fetch(coreJs, { method: 'HEAD' });
      console.log('[ffmpeg] core HEAD:', head.status, head.headers.get('content-length'));
      if (!head.ok) throw new Error('core HEAD not ok: ' + head.status);
    } catch (e) {
      console.error('[ffmpeg] core URL fetch failed:', e);
      throw new Error('Cannot reach ' + coreJs + ': ' + e.message);
    }

    try {
      const loadPromise = ff.load({
        coreURL: coreJs,
        wasmURL: coreWasm,
        classWorkerURL: chrome.runtime.getURL('libs/ffmpeg/worker.js'),
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ffmpeg load timeout (30s)')), 30000)
      );
      await Promise.race([loadPromise, timeoutPromise]);
    } catch (e) {
      console.error('[ffmpeg] load failed:', e);
      try { ff.terminate(); } catch {}
      throw new Error('ffmpeg-core load failed: ' + (e?.message || e));
    }

    console.log('[ffmpeg] core loaded successfully');
    _ffmpeg = ff;
    return ff;
  })();

  try {
    return await _loading;
  } finally {
    _loading = null;
  }
}

async function transcodeToPcm(inputFile, onProgress) {
  const ff = await getFFmpeg(onProgress);

  const inputName = 'in_' + Date.now() + '_' + inputFile.name.replace(/[^\w.-]/g, '_');
  const outputName = 'out.pcm';

  const buf = await inputFile.arrayBuffer();
  await ff.writeFile(inputName, new Uint8Array(buf));
  onProgress?.(0, 'Decoding...');

  let exitCode;
  try {
    exitCode = await ff.exec([
      '-i', inputName,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      outputName,
    ]);
  } catch (e) {
    throw new Error('ffmpeg exec failed: ' + (e?.message || e));
  }
  if (exitCode !== 0) {
    throw new Error('ffmpeg exit code ' + exitCode);
  }

  const data = await ff.readFile(outputName);
  await ff.deleteFile(inputName);
  await ff.deleteFile(outputName);

  return data; // Uint8Array of raw 16-bit signed little-endian PCM @ 16kHz mono
}

function pcmInt16ToFloat32(uint8) {
  const count = (uint8.byteLength / 2) | 0;
  const out = new Float32Array(count);
  const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
  for (let i = 0; i < count; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export async function extractAudioViaFfmpeg(file, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const onLog = options.onLog || (() => {});

  onLog('Loading ffmpeg-core...');
  const pcmData = await transcodeToPcm(file, onProgress);
  onLog('ffmpeg transcode done, converting PCM to Float32...');
  onProgress(95, 'Converting...');

  const audio = pcmInt16ToFloat32(pcmData);
  onProgress(100, 'Audio ready');
  onLog('Audio extracted: ' + (audio.length / 16000).toFixed(2) + 's, ' + (audio.byteLength / 1024 / 1024).toFixed(1) + 'MB');
  return audio;
}

export const transcoder = { extractAudioViaFfmpeg };
export default transcoder;

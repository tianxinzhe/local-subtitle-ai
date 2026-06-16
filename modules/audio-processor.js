const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION = 30;
const OVERLAP_DURATION = 2;

class AudioProcessor {
  constructor() {
    this._audioContext = null;
  }

  _getAudioContext() {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this._audioContext;
  }

  async decodeAudioFile(file, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const onLog = options.onLog || (() => {});

    const arrayBuffer = await file.arrayBuffer();
    onLog('decodeAudioData attempt: ' + arrayBuffer.byteLength + ' bytes');
    const audioContext = this._getAudioContext();
    if (audioContext.state === 'suspended') {
      try { await audioContext.resume(); } catch {}
    }
    try {
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      onLog('decodeAudioData OK: ' + audioBuffer.duration.toFixed(2) + 's @ ' + audioBuffer.sampleRate + 'Hz');

      const channelData = audioBuffer.getChannelData(0);
      let maxAbs = 0;
      for (let i = 0; i < channelData.length; i++) {
        const abs = Math.abs(channelData[i]);
        if (abs > maxAbs) maxAbs = abs;
      }

      if (maxAbs < 0.001 && audioBuffer.numberOfChannels > 1) {
        onLog('Audio quiet, summing ' + audioBuffer.numberOfChannels + ' channels');
        const combined = new Float32Array(audioBuffer.length);
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
          const ch = audioBuffer.getChannelData(c);
          for (let i = 0; i < ch.length; i++) combined[i] += ch[i];
        }
        for (let i = 0; i < combined.length; i++) combined[i] /= audioBuffer.numberOfChannels;
        onProgress(100, 'Decoded');
        return this._resample(combined, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
      }

      onProgress(100, 'Decoded');
      return this._resample(channelData, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
    } catch (err) {
      onLog('decodeAudioData failed (' + err.message + '), trying ffmpeg...');
      try {
        const { extractAudioViaFfmpeg } = await import('./transcoder.js');
        const result = await extractAudioViaFfmpeg(file, { onProgress, onLog });
        return result;
      } catch (ffErr) {
        onLog('ffmpeg transcode failed (' + ffErr.message + '), falling back to video element (real-time)...');
        return this.decodeAudioViaVideo(file, { onProgress, onLog });
      }
    }
  }

  async decodeAudioViaVideo(file, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const onLog = options.onLog || (() => {});

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.style.display = 'none';
    document.body.appendChild(video);

    const blobUrl = URL.createObjectURL(file);
    video.src = blobUrl;

    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Cannot load this file')), { once: true });
    });

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch {}
    }
    const sourceNode = audioCtx.createMediaElementSource(video);
    const destNode = audioCtx.createMediaStreamDestination();
    sourceNode.connect(destNode);

    const SEG = 60;
    const chunks = [];
    await video.play();
    onLog('Video playback started, capturing in ' + SEG + 's segments');

    for (let segIdx = 0; ; segIdx++) {
      const segStart = video.currentTime;
      const segBlob = await new Promise((resolve, reject) => {
        const parts = [];
        let rec;
        try {
          rec = new MediaRecorder(destNode.stream, { mimeType: 'audio/webm;codecs=opus' });
        } catch {
          rec = new MediaRecorder(destNode.stream);
        }
        rec.ondataavailable = (e) => { if (e.data.size > 0) parts.push(e.data); };
        rec.onstop = () => resolve(new Blob(parts, { type: 'audio/webm' }));
        rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
        rec.start();
        setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, SEG * 1000);
      });

      const buf = await segBlob.arrayBuffer();
      let decoded;
      try {
        decoded = await audioCtx.decodeAudioData(buf);
      } catch (err) {
        onLog('Segment ' + segIdx + ' decode failed: ' + err.message);
        continue;
      }
      const ch = decoded.getChannelData(0);
      chunks.push(new Float32Array(ch));

      const elapsed = video.currentTime - segStart;
      if (elapsed < 2 && segIdx > 0) {
        onLog('Video stalled at ' + video.currentTime.toFixed(2) + 's, ending capture');
        break;
      }
      onProgress(0, 'Segment ' + (segIdx + 1) + ' captured');
    }

    video.pause();
    URL.revokeObjectURL(blobUrl);
    if (video.parentNode) document.body.removeChild(video);
    audioCtx.close();

    if (chunks.length === 0) {
      throw new Error('No audio could be captured from the video');
    }

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { combined.set(c, off); off += c.length; }

    onLog('Captured ' + (combined.length / audioCtx.sampleRate).toFixed(2) + 's of audio, resampling to 16kHz');
    const resampled = this._resample(combined, audioCtx.sampleRate, TARGET_SAMPLE_RATE);
    onProgress(100, 'Audio ready');
    return resampled;
  }

  async decodeAudioSegment(file, startSec, durationSec) {
    const arrayBuffer = await file.arrayBuffer();
    const audioContext = this._getAudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const startSample = Math.floor(startSec * audioBuffer.sampleRate);
    const numSamples = Math.floor(durationSec * audioBuffer.sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    const segment = channelData.slice(startSample, startSample + numSamples);
    const resampled = await this._resample(segment, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
    return resampled;
  }

  _resample(input, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) {
      return input;
    }

    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.round(input.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcPos = i * ratio;
      const srcIndex = Math.floor(srcPos);
      const frac = srcPos - srcIndex;
      const nextIndex = Math.min(srcIndex + 1, input.length - 1);
      output[i] = input[srcIndex] * (1 - frac) + input[nextIndex] * frac;
    }

    return output;
  }

  splitIntoChunks(audioData, chunkDuration = CHUNK_DURATION, overlapDuration = OVERLAP_DURATION) {
    const sampleRate = TARGET_SAMPLE_RATE;
    const chunkSize = chunkDuration * sampleRate;
    const overlapSize = overlapDuration * sampleRate;
    const stepSize = chunkSize - overlapSize;
    const chunks = [];

    for (let offset = 0; offset < audioData.length; offset += stepSize) {
      const end = Math.min(offset + chunkSize, audioData.length);
      const chunk = audioData.slice(offset, end);
      chunks.push({
        data: chunk,
        start: offset / sampleRate,
        end: end / sampleRate,
        index: chunks.length,
      });
    }

    return chunks;
  }

  async extractFullAudioInChunks(file, options = {}) {
    const onChunk = options.onChunk || (() => {});
    const chunkDuration = options.chunkDuration || CHUNK_DURATION;
    const fileSize = file.size;

    const audioData = await this.decodeAudioFile(file);
    const chunks = this.splitIntoChunks(audioData, chunkDuration);

    for (const chunk of chunks) {
      await onChunk(chunk);
    }

    return chunks;
  }

  async *streamAudioChunks(file, chunkDuration = CHUNK_DURATION) {
    const audioData = await this.decodeAudioFile(file);
    const chunks = this.splitIntoChunks(audioData, chunkDuration);

    for (const chunk of chunks) {
      yield chunk;
    }
  }

  async captureTabAudio(stream, options = {}) {
    const onData = options.onData || (() => {});
    const chunkInterval = options.chunkInterval || 5;

    const audioContext = this._getAudioContext();
    const source = audioContext.createMediaStreamSource(stream);

    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    let buffer = [];
    let lastProcessTime = Date.now();

    return new Promise((resolve, reject) => {
      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        buffer.push(new Float32Array(inputData));

        const now = Date.now();
        if (now - lastProcessTime >= chunkInterval * 1000) {
          const combined = this._combineBuffers(buffer);
          const resampled = this._resample(combined, audioContext.sampleRate, TARGET_SAMPLE_RATE);

          onData({
            data: resampled,
            duration: combined.length / audioContext.sampleRate,
            timestamp: now,
          });

          buffer = [];
          lastProcessTime = now;
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      stream.getAudioTracks()[0].addEventListener('ended', () => {
        source.disconnect();
        processor.disconnect();
        if (buffer.length > 0) {
          const combined = this._combineBuffers(buffer);
          const resampled = this._resample(combined, audioContext.sampleRate, TARGET_SAMPLE_RATE);
          onData({
            data: resampled,
            duration: combined.length / audioContext.sampleRate,
            timestamp: Date.now(),
            final: true,
          });
        }
        resolve();
      });
    });
  }

  _combineBuffers(buffers) {
    let totalLength = 0;
    for (const buf of buffers) {
      totalLength += buf.length;
    }
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.length;
    }
    return result;
  }

  async captureTabAudioSimple(stream, onChunk, chunkInterval = 5) {
    return this.captureTabAudio(stream, { onData: onChunk, chunkInterval });
  }

  createSilentAudio(durationSec) {
    const sampleCount = Math.floor(durationSec * TARGET_SAMPLE_RATE);
    return new Float32Array(sampleCount);
  }

  createTestTone(frequency = 440, durationSec = 1, sampleRate = TARGET_SAMPLE_RATE) {
    const sampleCount = Math.floor(durationSec * sampleRate);
    const data = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      data[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.5;
    }
    return data;
  }

  getSampleRate() {
    return TARGET_SAMPLE_RATE;
  }
}

export const audioProcessor = new AudioProcessor();
export { TARGET_SAMPLE_RATE, CHUNK_DURATION };

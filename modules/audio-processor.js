const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION = 30;
const OVERLAP_DURATION = 2;

class AudioProcessor {
  constructor() {
    this._audioContext = null;
  }

  _getAudioContext() {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: TARGET_SAMPLE_RATE,
      });
    }
    return this._audioContext;
  }

  async decodeAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const audioContext = this._getAudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const channelData = audioBuffer.getChannelData(0);
    const resampled = this._resample(channelData, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
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
    const resampled = this._resample(segment, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
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

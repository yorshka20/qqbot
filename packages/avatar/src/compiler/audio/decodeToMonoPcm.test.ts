import { describe, expect, test } from 'bun:test';
import { decodeToMonoPcm } from './decodeToMonoPcm';

// ---------------------------------------------------------------------------
// WAV builder helpers
// ---------------------------------------------------------------------------

/** Build a minimal mono int16 WAV from Float32 samples (with int16 quantization). */
function buildMonoInt16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = 44 + dataSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);

  const enc = new TextEncoder();
  const writeStr = (offset: number, s: string) => {
    const b = enc.encode(s);
    for (let i = 0; i < b.length; i++) view.setUint8(offset + i, b[i]);
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byteRate
  view.setUint16(32, numChannels * bytesPerSample, true); // blockAlign
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  return new Uint8Array(buf);
}

/** Build a stereo int16 WAV where L=+1.0, R=-1.0 per frame. */
function buildStereoInt16Wav(frameCount: number, sampleRate: number): Uint8Array {
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = frameCount * numChannels * bytesPerSample;
  const fileSize = 44 + dataSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);

  const enc = new TextEncoder();
  const writeStr = (offset: number, s: string) => {
    const b = enc.encode(s);
    for (let i = 0; i < b.length; i++) view.setUint8(offset + i, b[i]);
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    view.setInt16(offset, 32767, true); // L = +1.0
    view.setInt16(offset + 2, -32767, true); // R = -1.0
    offset += 4;
  }

  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decodeToMonoPcm', () => {
  test('mono 8kHz 440Hz sine WAV decodes correctly', async () => {
    const sampleRate = 8000;
    const freqHz = 440;
    const durationSec = 1;
    const n = sampleRate * durationSec;
    const original = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      original[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    }

    const wavBytes = buildMonoInt16Wav(original, sampleRate);
    const { pcm, sampleRate: sr } = await decodeToMonoPcm(wavBytes, 'audio/wav');

    expect(sr).toBe(sampleRate);
    expect(pcm.length).toBe(n);
    // int16 quantization tolerance
    for (let i = 0; i < n; i++) {
      expect(Math.abs(pcm[i] - original[i])).toBeLessThan(1e-3);
    }
  });

  test('stereo WAV (L=+1, R=-1) downmixes to mono ≈ 0', async () => {
    const sampleRate = 8000;
    const frameCount = 1000;
    const wavBytes = buildStereoInt16Wav(frameCount, sampleRate);
    const { pcm, sampleRate: sr } = await decodeToMonoPcm(wavBytes, 'audio/wav');

    expect(sr).toBe(sampleRate);
    expect(pcm.length).toBe(frameCount);
    for (let i = 0; i < frameCount; i++) {
      expect(Math.abs(pcm[i])).toBeLessThan(1e-3);
    }
  });

  test('unknown mime throws with "unsupported" in message', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    await expect(decodeToMonoPcm(bytes, 'audio/ogg')).rejects.toThrow(/unsupported/i);
  });

  test('obviously invalid MP3 bytes reject', async () => {
    // Does not assert specific error text because ffmpeg and npm fallback
    // produce different messages.
    await expect(decodeToMonoPcm(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]), 'audio/mpeg')).rejects.toThrow();
  });
});

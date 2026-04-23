// ---------------------------------------------------------------------------
// Lazy ffmpeg availability detection
// ---------------------------------------------------------------------------

let ffmpegAvailablePromise: Promise<boolean> | null = null;

function detectFfmpeg(): Promise<boolean> {
  if (ffmpegAvailablePromise) return ffmpegAvailablePromise;
  ffmpegAvailablePromise = (async () => {
    try {
      const proc = Bun.spawn(['which', 'ffmpeg'], { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim().length > 0;
    } catch {
      return false;
    }
  })();
  return ffmpegAvailablePromise;
}

// ---------------------------------------------------------------------------
// WAV decoder (hand-written RIFF parser, no npm deps)
// ---------------------------------------------------------------------------

function decodeWav(bytes: Uint8Array): { pcm: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Validate RIFF/WAVE header
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF') throw new Error('Not a RIFF file');
  if (wave !== 'WAVE') throw new Error('Not a WAVE file');

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  // Walk chunks starting at offset 12
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const chunkSize = view.getUint32(pos + 4, true);

    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(pos + 8, true);
      numChannels = view.getUint16(pos + 10, true);
      sampleRate = view.getUint32(pos + 12, true);
      bitsPerSample = view.getUint16(pos + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = pos + 8;
      dataSize = chunkSize;
    }

    pos += 8 + chunkSize;
    // Align to even boundary
    if (chunkSize % 2 !== 0) pos += 1;
  }

  if (dataOffset === -1) throw new Error('WAV missing data chunk');
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`Unsupported WAV audioFormat: ${audioFormat} (only PCM=1 and float32=3 supported)`);
  }
  if (numChannels < 1) throw new Error('WAV has no channels');

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const framesCount = Math.floor(totalSamples / numChannels);
  const pcm = new Float32Array(framesCount);

  if (audioFormat === 1 && bitsPerSample === 16) {
    // PCM int16 — downmix to mono
    for (let i = 0; i < framesCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const offset = dataOffset + (i * numChannels + ch) * 2;
        sum += view.getInt16(offset, true) / 32768;
      }
      pcm[i] = sum / numChannels;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    // IEEE float32 — downmix to mono
    for (let i = 0; i < framesCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const offset = dataOffset + (i * numChannels + ch) * 4;
        sum += view.getFloat32(offset, true);
      }
      pcm[i] = sum / numChannels;
    }
  } else {
    throw new Error(`Unsupported WAV bitsPerSample: ${bitsPerSample} for audioFormat ${audioFormat}`);
  }

  return { pcm, sampleRate };
}

// ---------------------------------------------------------------------------
// MP3 via ffmpeg (preferred when available)
// ---------------------------------------------------------------------------

async function decodeMp3ViaFfmpeg(bytes: Uint8Array): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const proc = Bun.spawn(
    ['ffmpeg', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '24000', 'pipe:1'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );

  // Write MP3 bytes to stdin then close
  proc.stdin.write(bytes);
  proc.stdin.end();

  const [rawPcm, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`ffmpeg decode failed (exit ${exitCode}): ${stderrText.trim()}`);
  }

  const pcm = new Float32Array(rawPcm);
  return { pcm, sampleRate: 24000 };
}

// ---------------------------------------------------------------------------
// MP3 via pure-JS fallback (audio-decode, no ffmpeg needed)
// ---------------------------------------------------------------------------

async function decodeMp3ViaNpm(bytes: Uint8Array): Promise<{ pcm: Float32Array; sampleRate: number }> {
  // Dynamic import to keep startup cost zero when ffmpeg is available.
  const { default: decode } = await import('audio-decode');
  const result = await (decode as (buf: Uint8Array) => Promise<{ channelData: Float32Array[]; sampleRate: number }>)(
    bytes,
  );
  const { channelData, sampleRate } = result;

  if (!channelData || channelData.length === 0) {
    throw new Error('audio-decode returned no channel data');
  }

  const frameCount = channelData[0].length;
  const numChannels = channelData.length;
  const pcm = new Float32Array(frameCount);

  if (numChannels === 1) {
    pcm.set(channelData[0]);
  } else {
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += channelData[ch][i];
      }
      pcm[i] = sum / numChannels;
    }
  }

  return { pcm, sampleRate };
}

// ---------------------------------------------------------------------------
// Raw PCM decoder (audio/pcm)
// ---------------------------------------------------------------------------

export interface DecodePcmOpts {
  /** Required when mime is audio/pcm. */
  sampleRate: number;
  /** Sample format. Default 's16le'. */
  format?: 's16le' | 'f32';
}

function decodePcm(bytes: Uint8Array, opts: DecodePcmOpts): { pcm: Float32Array; sampleRate: number } {
  const format = opts.format ?? 's16le';

  if (format === 'f32') {
    // Always copy the byte range so the returned Float32Array owns its buffer
    // (callers may detach or reuse the input view) and alignment is guaranteed.
    const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { pcm: new Float32Array(sliced), sampleRate: opts.sampleRate };
  }

  // s16le: little-endian signed int16 mono
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameCount = Math.floor(bytes.byteLength / 2);
  const pcm = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    pcm[i] = view.getInt16(i * 2, true) / 32768;
  }
  return { pcm, sampleRate: opts.sampleRate };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode audio bytes to mono Float32 PCM.
 *
 * Supported mime types:
 *   - audio/wav, audio/wave, audio/x-wav  (hand-written RIFF parser)
 *   - audio/mpeg, audio/mp3               (ffmpeg if available, else audio-decode fallback)
 *   - audio/pcm                           (raw PCM; opts.sampleRate required)
 */
export async function decodeToMonoPcm(
  bytes: Uint8Array,
  mime: string,
  opts?: DecodePcmOpts,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const m = mime.toLowerCase();
  if (m === 'audio/wav' || m === 'audio/wave' || m === 'audio/x-wav') {
    return decodeWav(bytes);
  }
  if (m === 'audio/mpeg' || m === 'audio/mp3') {
    const hasFfmpeg = await detectFfmpeg();
    return hasFfmpeg ? decodeMp3ViaFfmpeg(bytes) : decodeMp3ViaNpm(bytes);
  }
  if (m === 'audio/pcm') {
    if (!opts?.sampleRate) throw new Error('audio/pcm requires sampleRate');
    return decodePcm(bytes, opts);
  }
  throw new Error(`unsupported mime: ${mime}`);
}

// Exported for test-time spying (allows forcing ffmpeg=false to cover fallback path)
export { detectFfmpeg };

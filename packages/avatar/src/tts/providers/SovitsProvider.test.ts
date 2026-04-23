import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SovitsProvider, substitutePlaceholders } from './SovitsProvider';

// ─── substitutePlaceholders ───────────────────────────────────────────────────

describe('substitutePlaceholders', () => {
  it('replaces {text} in a flat string value', () => {
    const result = substitutePlaceholders({ q: '{text}' }, { text: 'hello' });
    expect(result).toEqual({ q: 'hello' });
  });

  it('replaces {voice} when voice is provided', () => {
    const result = substitutePlaceholders({ speaker: '{voice}' }, { text: 'hi', voice: 'anna' });
    expect(result).toEqual({ speaker: 'anna' });
  });

  it('leaves {voice} unchanged when voice is not provided', () => {
    const result = substitutePlaceholders({ speaker: '{voice}' }, { text: 'hi' });
    expect(result).toEqual({ speaker: '{voice}' });
  });

  it('replaces both {text} and {voice} in the same string', () => {
    const result = substitutePlaceholders({ q: 'Say "{text}" as {voice}' }, { text: 'hello', voice: 'bob' });
    expect(result).toEqual({ q: 'Say "hello" as bob' });
  });

  it('recurses into nested objects', () => {
    const template = { outer: { inner: '{text}' } };
    const result = substitutePlaceholders(template, { text: 'deep' });
    expect(result).toEqual({ outer: { inner: 'deep' } });
  });

  it('recurses into arrays', () => {
    const template = { items: ['{text}', 'static', '{voice}'] };
    const result = substitutePlaceholders(template, { text: 'a', voice: 'b' });
    expect(result).toEqual({ items: ['a', 'static', 'b'] });
  });

  it('does not mutate the original template', () => {
    const template = { q: '{text}' };
    substitutePlaceholders(template, { text: 'x' });
    expect(template.q).toBe('{text}');
  });

  it('handles non-string primitives without modification', () => {
    const template = { count: 5 as unknown as string, flag: true as unknown as string };
    const result = substitutePlaceholders(template as Record<string, unknown>, { text: 'x' });
    expect(result).toEqual({ count: 5, flag: true });
  });

  it('replaces multiple occurrences of {text} in one string', () => {
    const result = substitutePlaceholders({ q: '{text} and {text}' }, { text: 'hi' });
    expect(result).toEqual({ q: 'hi and hi' });
  });
});

// ─── SovitsProvider.synthesize ────────────────────────────────────────────────

describe('SovitsProvider', () => {
  const fakeBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeMockFetch(opts: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    contentType?: string;
    body?: Uint8Array;
  }) {
    const { ok = true, status = 200, statusText = 'OK', contentType = 'audio/wav', body = fakeBytes } = opts;
    return mock(async (_url: string, _init?: RequestInit) => ({
      ok,
      status,
      statusText,
      headers: { get: (h: string) => (h === 'Content-Type' ? contentType : null) },
      arrayBuffer: async () => body.buffer,
    })) as unknown as typeof globalThis.fetch;
  }

  it('isAvailable returns true when endpoint is set', () => {
    const p = new SovitsProvider({ endpoint: 'http://localhost:9999', bodyTemplate: {} });
    expect(p.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when endpoint is empty', () => {
    const p = new SovitsProvider({ endpoint: '', bodyTemplate: {} });
    expect(p.isAvailable()).toBe(false);
  });

  it('calls fetch with substituted body and returns wav result', async () => {
    const fetchMock = makeMockFetch({ contentType: 'audio/wav' });
    globalThis.fetch = fetchMock;

    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: { text: '{text}', speaker: '{voice}' },
      defaultVoice: 'alice',
    });
    const result = await p.synthesize('hello', { voice: 'bob' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sovits/tts');
    // synthesize() always injects non-streaming wav fields on top of the template.
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'hello',
      speaker: 'bob',
      streaming_mode: false,
      media_type: 'wav',
    });
    expect(result.mime).toBe('audio/wav');
    expect(result.bytes).toBeInstanceOf(Uint8Array);
  });

  it('always returns audio/wav mime regardless of server Content-Type', async () => {
    // Some GPT-SoVITS builds mislabel the Content-Type (e.g. `application/octet-stream`).
    // synthesize() must still report `audio/wav` because we asked the server for wav.
    globalThis.fetch = makeMockFetch({ contentType: 'application/octet-stream' });
    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: { text: '{text}' },
    });
    const result = await p.synthesize('hi');
    expect(result.mime).toBe('audio/wav');
  });

  it('overwrites streaming fields already present in the template', async () => {
    // Regression: earlier versions of the provider passed bodyTemplate through
    // verbatim, so a template with streaming_mode=true + media_type=raw made
    // /tts return raw PCM bytes mislabelled as wav — Milky then rejected the
    // record segment with "消息体无法解析" (500). synthesize() must now force
    // non-streaming wav output irrespective of template contents.
    const fetchMock = makeMockFetch({ contentType: 'audio/wav' });
    globalThis.fetch = fetchMock;
    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: {
        text: '{text}',
        text_lang: 'zh',
        streaming_mode: true,
        media_type: 'raw',
      },
    });
    await p.synthesize('hi');
    const [, init] = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.streaming_mode).toBe(false);
    expect(body.media_type).toBe('wav');
    // Stable template fields are preserved.
    expect(body.text).toBe('hi');
    expect(body.text_lang).toBe('zh');
  });

  it('uses defaultVoice when opts.voice is not provided', async () => {
    const fetchMock = makeMockFetch({});
    globalThis.fetch = fetchMock;

    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: { speaker: '{voice}' },
      defaultVoice: 'default-speaker',
    });
    await p.synthesize('text');
    const [, init] = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      speaker: 'default-speaker',
      streaming_mode: false,
      media_type: 'wav',
    });
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = makeMockFetch({ ok: false, status: 500, statusText: 'Internal Server Error' });
    const p = new SovitsProvider({ endpoint: 'http://sovits/tts', bodyTemplate: {} });
    await expect(p.synthesize('hi')).rejects.toThrow('500');
  });

  it('includes API JSON error body on non-ok response', async () => {
    const errBody = new TextEncoder().encode(JSON.stringify({ message: 'ref_audio_path not found' }));
    globalThis.fetch = makeMockFetch({ ok: false, status: 400, statusText: 'Bad Request', body: errBody });
    const p = new SovitsProvider({ endpoint: 'http://sovits/tts', bodyTemplate: { text: '{text}' } });
    await expect(p.synthesize('x')).rejects.toThrow(/ref_audio_path not found/);
  });

  it('appends Exception when message is generic (GPT-SoVITS style)', async () => {
    const errBody = new TextEncoder().encode(
      JSON.stringify({ message: 'tts failed', Exception: 'FileNotFoundError: H:/x.wav' }),
    );
    globalThis.fetch = makeMockFetch({ ok: false, status: 400, body: errBody });
    const p = new SovitsProvider({ endpoint: 'http://sovits/tts', bodyTemplate: { text: '{text}' } });
    const err = await p.synthesize('x').then(
      () => {
        throw new Error('expected throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/tts failed/);
    expect((err as Error).message).toMatch(/FileNotFoundError/);
  });

  it('trims text before building the request body', async () => {
    const fetchMock = makeMockFetch({ contentType: 'audio/wav' });
    globalThis.fetch = fetchMock;
    const p = new SovitsProvider({ endpoint: 'http://sovits/tts', bodyTemplate: { text: '{text}' } });
    await p.synthesize('  hello  ');
    const [, init] = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'hello',
      streaming_mode: false,
      media_type: 'wav',
    });
  });
});

// ─── SovitsProvider.synthesizeStream ──────────────────────────────────────────

describe('SovitsProvider.synthesizeStream', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Build a mock fetch that returns a streaming response from the given chunks. */
  function makeStreamFetch(chunks: Uint8Array[], status = 200, statusText = 'OK') {
    return mock(async (_url: string, _init?: RequestInit) => {
      if (status !== 200) {
        return {
          ok: false,
          status,
          statusText,
          headers: { get: () => null },
          arrayBuffer: async () => new Uint8Array(0).buffer,
          body: null,
        };
      }
      // Build a ReadableStream that yields each chunk in sequence.
      let idx = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (idx < chunks.length) {
            controller.enqueue(chunks[idx++]);
          } else {
            controller.close();
          }
        },
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body,
      };
    }) as unknown as typeof globalThis.fetch;
  }

  it('throws when pcmSampleRate is not configured', async () => {
    // streaming_mode / media_type are now forced by the provider, so
    // pcmSampleRate is the only remaining config invariant — raw PCM has no
    // in-band sample rate and the renderer needs one to init its AudioContext.
    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: {},
    });
    await expect(async () => {
      for await (const _ of p.synthesizeStream('hi')) {
        /* consume */
      }
    }).toThrow(/pcmSampleRate/);
  });

  it('forces streaming_mode=true + media_type=raw into the request body', async () => {
    const fetchMock = makeStreamFetch([new Uint8Array([0x01, 0x02])]);
    globalThis.fetch = fetchMock;
    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      // Template without any streaming fields — the provider must inject them.
      bodyTemplate: { text: '{text}', text_lang: 'zh' },
      pcmSampleRate: 32000,
    });
    for await (const _ of p.synthesizeStream('hi')) {
      /* consume */
    }
    const [, init] = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.streaming_mode).toBe(true);
    expect(body.media_type).toBe('raw');
    expect(body.text).toBe('hi');
    expect(body.text_lang).toBe('zh');
  });

  it('happy path: yields data chunks then terminator with isLast=true', async () => {
    const chunk1 = new Uint8Array([0x01, 0x02]);
    const chunk2 = new Uint8Array([0x03, 0x04]);
    globalThis.fetch = makeStreamFetch([chunk1, chunk2]);

    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: { text: '{text}' },
      pcmSampleRate: 32000,
    });

    const collected: Array<{ bytes: Uint8Array; mime: string; sampleRate?: number; isLast: boolean }> = [];
    for await (const chunk of p.synthesizeStream('hello')) {
      collected.push(chunk);
    }

    // Should have 2 data chunks plus 1 terminator
    expect(collected.length).toBe(3);

    // Data chunks carry stable mime and sampleRate
    expect(collected[0].mime).toBe('audio/pcm');
    expect(collected[0].sampleRate).toBe(32000);
    expect(collected[0].isLast).toBe(false);
    expect(collected[0].bytes).toEqual(chunk1);

    expect(collected[1].mime).toBe('audio/pcm');
    expect(collected[1].sampleRate).toBe(32000);
    expect(collected[1].isLast).toBe(false);
    expect(collected[1].bytes).toEqual(chunk2);

    // Terminator chunk
    expect(collected[2].isLast).toBe(true);
    expect(collected[2].bytes.length).toBe(0);
    expect(collected[2].mime).toBe('audio/pcm');
    expect(collected[2].sampleRate).toBe(32000);
  });

  it('throws with HTTP error detail on 500', async () => {
    globalThis.fetch = makeStreamFetch([], 500, 'Internal Server Error');
    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: {},
      pcmSampleRate: 32000,
    });
    await expect(async () => {
      for await (const _ of p.synthesizeStream('hi')) {
        /* consume */
      }
    }).toThrow(/500/);
  });

  it('throws on stream read failure', async () => {
    // Build a fetch whose body throws during read.
    globalThis.fetch = mock(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('network interrupted'));
        },
      });
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, body };
    }) as unknown as typeof globalThis.fetch;

    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: {},
      pcmSampleRate: 32000,
    });
    await expect(async () => {
      for await (const _ of p.synthesizeStream('hi')) {
        /* consume */
      }
    }).toThrow(/stream read failure/);
  });

  // ─── Sample-boundary alignment ──────────────────────────────────────────────
  //
  // Regression: HTTP chunked transfer produced odd-byte reads (e.g. 1441 bytes)
  // which, when decoded as s16le by both the RMS pipeline and the renderer,
  // dropped the trailing byte and shifted the int16 grid by 1 for the rest of
  // the stream — audible as pure white noise. The provider now buffers trailing
  // sub-sample bytes and only yields chunks with even byte lengths.
  it('carries odd-byte residual across reads and yields only sample-aligned chunks', async () => {
    // 3 + 4 + 1 = 8 bytes total (4 s16 samples).
    // After buffering: yield[0]=2 bytes, yield[1]=6 bytes, no residual.
    const r1 = new Uint8Array([0x01, 0x02, 0x03]);
    const r2 = new Uint8Array([0x04, 0x05, 0x06, 0x07]);
    const r3 = new Uint8Array([0x08]);
    globalThis.fetch = makeStreamFetch([r1, r2, r3]);

    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: { text: '{text}' },
      pcmSampleRate: 32000,
    });

    const collected: Uint8Array[] = [];
    for await (const chunk of p.synthesizeStream('hello')) {
      if (!chunk.isLast) collected.push(chunk.bytes);
      // Data chunks must be sample-aligned (2 bytes/sample for s16le).
      if (!chunk.isLast) expect(chunk.bytes.length % 2).toBe(0);
    }

    // Concatenating all yielded chunks must reproduce the original byte
    // sequence exactly, in order — no data loss, no reordering.
    const flat = new Uint8Array(collected.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of collected) {
      flat.set(c, o);
      o += c.length;
    }
    expect(Array.from(flat)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  });

  it('suppresses yields that would contain less than one full sample', async () => {
    // Single byte reads — provider must not yield zero-byte data chunks.
    const reads = [new Uint8Array([0x01]), new Uint8Array([0x02]), new Uint8Array([0x03]), new Uint8Array([0x04])];
    globalThis.fetch = makeStreamFetch(reads);

    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: {},
      pcmSampleRate: 32000,
    });

    const dataChunks: Uint8Array[] = [];
    for await (const chunk of p.synthesizeStream('hi')) {
      if (!chunk.isLast) {
        dataChunks.push(chunk.bytes);
        expect(chunk.bytes.length).toBeGreaterThan(0);
        expect(chunk.bytes.length % 2).toBe(0);
      }
    }
    // 4 single-byte reads → two 2-byte yields OR one 4-byte yield, depending
    // on coalescing timing. Either way, total yielded bytes = 4 and each
    // yield is individually aligned.
    const total = dataChunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(4);
  });

  it('drops a trailing orphan byte at stream end without emitting it', async () => {
    // 3 total bytes — after alignment, 2 yielded and 1 dropped at EOS.
    const r1 = new Uint8Array([0x01, 0x02, 0x03]);
    globalThis.fetch = makeStreamFetch([r1]);

    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: {},
      pcmSampleRate: 32000,
    });

    const dataChunks: Uint8Array[] = [];
    let terminator: { isLast: boolean; bytes: Uint8Array } | null = null;
    for await (const chunk of p.synthesizeStream('hi')) {
      if (chunk.isLast) terminator = { isLast: chunk.isLast, bytes: chunk.bytes };
      else dataChunks.push(chunk.bytes);
    }

    expect(dataChunks.length).toBe(1);
    expect(Array.from(dataChunks[0])).toEqual([0x01, 0x02]);
    expect(terminator).not.toBeNull();
    expect(terminator?.bytes.length).toBe(0);
  });
});

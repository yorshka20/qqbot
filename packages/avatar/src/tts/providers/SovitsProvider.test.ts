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
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello', speaker: 'bob' });
    expect(result.mime).toBe('audio/wav');
    expect(result.bytes).toBeInstanceOf(Uint8Array);
  });

  it('uses responseFormat over Content-Type for mime', async () => {
    globalThis.fetch = makeMockFetch({ contentType: 'audio/wav' });
    const p = new SovitsProvider({
      endpoint: 'http://sovits/tts',
      bodyTemplate: { text: '{text}' },
      responseFormat: 'audio/mpeg',
    });
    const result = await p.synthesize('hi');
    expect(result.mime).toBe('audio/mpeg');
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
    expect(JSON.parse(init.body as string)).toEqual({ speaker: 'default-speaker' });
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
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' });
  });
});

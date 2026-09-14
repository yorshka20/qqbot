// Pins the NovelAI request body to the shape the V5 endpoint accepts.
//
// The wire contract is not documented: NovelAI's published OpenAPI types `parameters` as a
// bare object and its model enum still stops at V3, so the field set here was read off the
// web client's own default table and request sanitizer. That makes it easy to regress
// silently — a stale field is accepted and ignored rather than rejected — hence these tests.

import 'reflect-metadata';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NovelAIProvider } from './NovelAIProvider';

type CapturedRequest = {
  url: string;
  body: {
    action: string;
    model: string;
    input: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Captures the outbound request and answers with an empty archive. These tests assert on what
 * goes out, so the extractor is allowed to reject the body rather than writing a file per test.
 */
function stubFetch(): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');

  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(new Uint8Array(emptyZip), {
      status: 200,
      headers: { 'content-type': 'binary/octet-stream' },
    });
  }) as unknown as typeof fetch;

  return { captured };
}

function makeProvider(model?: string) {
  return new NovelAIProvider({
    type: 'novelai',
    accessToken: 'test-token',
    ...(model ? { model } : {}),
  });
}

describe('NovelAIProvider request body', () => {
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = stubFetch().captured;
  });

  it('targets the image host and defaults to V5 Full', async () => {
    await makeProvider().generateImage('1girl, solo');

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://image.novelai.net/ai/generate-image');
    expect(captured[0]?.body.model).toBe('nai-diffusion-5-full');
    expect(captured[0]?.body.action).toBe('generate');
    expect(captured[0]?.body.input).toBe('1girl, solo');
  });

  it('sends params_version 4 and the V5 conditioning block', async () => {
    await makeProvider().generateImage('1girl, solo');
    const params = captured[0]?.body.parameters ?? {};

    expect(params.params_version).toBe(4);
    // V5 reuses the v4 caption structure; there is no v5_prompt field.
    expect(params.v4_prompt).toEqual({
      caption: { base_caption: '1girl, solo', char_captions: [] },
      use_coords: false,
      use_order: true,
    });
    expect(params).not.toHaveProperty('v5_prompt');
    expect(params).not.toHaveProperty('prompt');
  });

  it('omits the fields no V4-or-later model accepts', async () => {
    await makeProvider().generateImage('1girl, solo');
    const params = captured[0]?.body.parameters ?? {};

    for (const dead of ['sm', 'sm_dyn', 'autoSmea', 'ucPreset', 'qualityToggle', 'skip_cfg_above_sigma']) {
      expect(params).not.toHaveProperty(dead);
    }
  });

  it('forces the karras schedule and its ancestral-noise switches', async () => {
    await makeProvider().generateImage('1girl, solo');
    const params = captured[0]?.body.parameters ?? {};

    expect(params.sampler).toBe('k_euler_ancestral');
    expect(params.noise_schedule).toBe('karras');
    expect(params.prefer_brownian).toBe(true);
    expect(params.deliberate_euler_ancestral_bug).toBe(false);
  });

  it('takes the guidance scale from the model when config does not set one', async () => {
    await makeProvider('nai-diffusion-5-full').generateImage('a');
    await makeProvider('nai-diffusion-4-5-full').generateImage('a');

    expect(captured[0]?.body.parameters.scale).toBe(7);
    expect(captured[1]?.body.parameters.scale).toBe(5);
  });

  it('honours caller overrides and snaps dimensions to a multiple of 64', async () => {
    // 820x1200 snaps to 832x1216, which is inside the pixel budget — so this exercises
    // alignment on its own, with the allowance clamp covered separately below.
    await makeProvider().generateImage('a', { prompt: 'a', width: 820, height: 1200, steps: 24, guidance_scale: 6 });
    const params = captured[0]?.body.parameters ?? {};

    expect(params.width).toBe(832);
    expect(params.height).toBe(1216);
    expect(params.steps).toBe(24);
    expect(params.scale).toBe(6);
  });

  it('caps steps at the free-allowance ceiling however high the caller asks', async () => {
    // ImagePromptService hands every provider a cross-provider default; for NovelAI anything
    // above 28 quietly turns a free generation into an Anlas charge.
    await makeProvider().generateImage('a', { prompt: 'a', steps: 45 });

    expect(captured[0]?.body.parameters.steps).toBe(28);
  });

  it('scales an oversized request back under the free pixel budget, keeping the aspect ratio', async () => {
    await makeProvider().generateImage('a', { prompt: 'a', width: 1856, height: 2464 });
    const params = captured[0]?.body.parameters ?? {};
    const width = params.width as number;
    const height = params.height as number;

    expect(width * height).toBeLessThanOrEqual(1048576);
    expect(width % 64).toBe(0);
    expect(height % 64).toBe(0);
    // 1856x2464 is 3:4; the clamped result must still be close to it.
    expect(width / height).toBeCloseTo(1856 / 2464, 1);
  });

  it('leaves a request that already fits the allowance untouched', async () => {
    await makeProvider().generateImage('a', { prompt: 'a', width: 832, height: 1216, steps: 28 });
    const params = captured[0]?.body.parameters ?? {};

    expect(params.width).toBe(832);
    expect(params.height).toBe(1216);
    expect(params.steps).toBe(28);
    expect((params.width as number) * (params.height as number)).toBeLessThanOrEqual(1048576);
  });

  it('rejects a model the endpoint no longer serves', async () => {
    const result = await makeProvider('nai-diffusion-3').generateImage('a');

    expect(captured).toHaveLength(0);
    expect(result.images).toEqual([]);
    expect(result.metadata?.errorMessage).toContain('Unsupported model: nai-diffusion-3');
  });

  it('leaves strength and noise off a text-only generation', async () => {
    await makeProvider().generateImage('a');
    const params = captured[0]?.body.parameters ?? {};

    expect(params).not.toHaveProperty('image');
    expect(params).not.toHaveProperty('strength');
    expect(params).not.toHaveProperty('noise');
  });
});

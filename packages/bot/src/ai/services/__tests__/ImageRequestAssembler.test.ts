import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { HookContext } from '@/hooks/types';
import type { ImageGenerationService } from '../ImageGenerationService';
import { ImageFacadeService } from '../ImageFacadeService';
import { ImageRequestAssembler, ImageRequestAssemblyError } from '../ImageRequestAssembler';
import type { ImagePromptService } from '../ImagePromptService';

function presetDir(root: string, id: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePreset(dir: string, manifest: unknown, files: Record<string, string> = {}): void {
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(manifest));
}

describe('ImageRequestAssembler', () => {
  it('returns the caller inputs unchanged when no preset is cited', () => {
    const root = mkdtempSync(join(tmpdir(), 'img-preset-'));
    const assembled = ImageRequestAssembler.assemble(
      {
        prompt: 'a cat',
        messageImages: ['https://example.com/a.png'],
      },
      root,
    );
    expect(assembled.prompt).toBe('a cat');
    expect(assembled.referenceImages).toEqual(['https://example.com/a.png']);
    expect(assembled.presets).toEqual([]);
  });

  it('appends preset images after message images and keeps the description verbatim', () => {
    const root = mkdtempSync(join(tmpdir(), 'img-preset-'));
    const hero = presetDir(root, 'hero');
    writePreset(hero, { name: '角色甲', aliases: ['甲', '角色甲'], description: '黑发，左眼下有一颗小痣。' }, {
      'b.png': 'b',
      'a.png': 'a',
    });
    writeFileSync(join(hero, 'notes.txt'), 'not an image');

    expect(ImageRequestAssembler.list(root)).toEqual([
      { id: 'hero', name: '角色甲', aliases: ['甲'], imageCount: 2 },
    ]);

    const assembled = ImageRequestAssembler.assemble(
      {
        prompt: '站在窗边',
        messageImages: ['https://example.com/msg.png'],
        presetIds: ['hero', 'hero', '  hero  '],
      },
      root,
    );

    expect(assembled.referenceImages).toEqual([
      'https://example.com/msg.png',
      realpathSync(join(hero, 'a.png')),
      realpathSync(join(hero, 'b.png')),
    ]);
    expect(assembled.prompt.startsWith('站在窗边')).toBe(true);
    expect(assembled.prompt).toContain('黑发，左眼下有一颗小痣。');
    expect(assembled.prompt).toContain('[preset:hero] 角色甲（2 张参考图）');
    expect(assembled.prompt).toContain('用户消息中的 1 张');
    expect(assembled.presets.map((preset) => preset.id)).toEqual(['hero']);
  });

  it('keeps an explicit image list in the declared order', () => {
    const root = mkdtempSync(join(tmpdir(), 'img-preset-'));
    const hero = presetDir(root, 'hero');
    writePreset(
      hero,
      { description: '精确描述', images: ['second.png', 'first.png'] },
      { 'first.png': '1', 'second.png': '2' },
    );
    const assembled = ImageRequestAssembler.assemble(
      {
        prompt: 'pose',
        messageImages: [],
        presetIds: ['hero'],
      },
      root,
    );
    expect(assembled.referenceImages).toEqual([
      realpathSync(join(hero, 'second.png')),
      realpathSync(join(hero, 'first.png')),
    ]);
  });

  it('rejects an unknown id and a preset whose image path escapes the directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'img-preset-'));
    const outside = join(root, 'secret.png');
    writeFileSync(outside, 'nope');
    const broken = presetDir(root, 'broken');
    writePreset(broken, { description: '逃逸', images: ['../../secret.png'] }, { 'ok.png': 'ok' });
    const hero = presetDir(root, 'hero');
    writePreset(hero, { description: '可用' }, { 'ref.png': 'ref' });

    expect(ImageRequestAssembler.list(root).map((preset) => preset.id)).toEqual(['hero']);

    expect(() => ImageRequestAssembler.assemble({ prompt: 'x', messageImages: [], presetIds: ['missing'] }, root)).toThrow(
      ImageRequestAssemblyError,
    );
    expect(() => ImageRequestAssembler.assemble({ prompt: 'x', messageImages: [], presetIds: ['broken'] }, root)).toThrow(
      /escapes the preset directory/,
    );
  });

  it('rejects a symlink that points outside the preset directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'img-preset-'));
    const outside = join(root, 'outside.png');
    writeFileSync(outside, 'nope');
    const hero = presetDir(root, 'hero');
    symlinkSync(outside, join(hero, 'link.png'));
    writePreset(hero, { description: '链接', images: ['link.png'] });

    expect(() =>
      ImageRequestAssembler.assemble({ prompt: 'x', messageImages: [], presetIds: ['hero'] }, root),
    ).toThrow(/escapes the preset directory/);
  });
});

describe('ImageFacadeService preset assembly', () => {
  it('sends the assembled prompt and images, and does not forward preset ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'img-preset-'));
    const hero = presetDir(root, 'hero');
    writePreset(hero, { description: '精确外观' }, { 'ref.png': 'ref' });

    let seenPrompt = '';
    let preprocessInput = '';
    const recorded: { images: string[]; options: unknown }[] = [];
    const facade = new ImageFacadeService(
      { execute: async () => true } as never,
      {
        generateImageFromImage: async (images: string[], prompt: string, options: unknown) => {
          recorded.push({ images, options });
          seenPrompt = prompt;
          return { images: [{ url: 'https://example.com/out.png' }] };
        },
      } as unknown as ImageGenerationService,
      {
        prepareImageGenerationParams: async (input: string) => {
          preprocessInput = input;
          return { prompt: '润色后的画面', options: { prompt: '润色后的画面' } };
        },
      } as unknown as ImagePromptService,
      root,
    );

    const context = {
      metadata: {
        get: () => undefined,
        set: () => undefined,
      },
    } as unknown as HookContext;

    await facade.generateImageFromImage(
      context,
      ['https://example.com/msg.png'],
      '用户原话',
      { presetIds: ['hero'], model: 'gpt-image-2' },
      'openai',
      true,
    );

    expect(preprocessInput).toBe('用户原话');
    expect(seenPrompt.startsWith('润色后的画面')).toBe(true);
    expect(seenPrompt).toContain('精确外观');
    expect(recorded[0]?.images).toEqual(['https://example.com/msg.png', realpathSync(join(hero, 'ref.png'))]);
    expect(recorded[0]?.options).toEqual({ model: 'gpt-image-2' });
  });
});

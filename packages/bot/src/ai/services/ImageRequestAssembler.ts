// Assembles an image-generation request before any provider maps it onto its API.
//
// Callers supply the user prompt, every reference image already taken from the
// triggering message (and the message it replies to), and any preset ids.
// This module appends each preset's precise description to the prompt and its
// local reference images after the message images. Providers then apply their
// own limits: gpt-image and Gemini accept the whole list; NovelAI denoises
// from the first image only.
//
// Presets live in `data/image-presets/<id>/preset.json`:
//   { "name": "...", "aliases": ["..."], "description": "...", "images": ["a.png"] }
// `images` are paths relative to that directory. Omit `images` to use every
// png/jpeg/webp/gif in the directory, sorted by filename.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class ImageRequestAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRequestAssemblyError';
  }
}

/** Catalog entry shown to the chat model. The precise description stays out of this view. */
export interface ImagePresetSummary {
  id: string;
  name: string;
  aliases: string[];
  imageCount: number;
}

export interface ImagePreset extends ImagePresetSummary {
  description: string;
  /** Absolute paths, in the order they are attached to the request. */
  images: string[];
}

export interface AssembledImageRequest {
  prompt: string;
  /** Message images first, then each cited preset's images. */
  referenceImages: string[];
  presets: ImagePreset[];
}

export interface AssembleImageRequestInput {
  prompt: string;
  messageImages: string[];
  presetIds?: string[];
}

interface ParsedPresetFile {
  name?: string;
  aliases?: unknown;
  description?: string;
  images?: unknown;
}

export class ImageRequestAssembler {
  /** Valid presets only. Broken directories are skipped (logged at debug). */
  static list(root: string = ImageRequestAssembler.presetsRoot()): ImagePresetSummary[] {
    return ImageRequestAssembler.scan(root).valid.map((preset) => ({
      id: preset.id,
      name: preset.name,
      aliases: preset.aliases,
      imageCount: preset.images.length,
    }));
  }

  /**
   * Merge message images with the cited presets.
   * An empty citation returns the inputs unchanged, so a second call with no
   * preset ids does not append the description block again.
   */
  static assemble(
    input: AssembleImageRequestInput,
    root: string = ImageRequestAssembler.presetsRoot(),
  ): AssembledImageRequest {
    const ids = normalizePresetIds(input.presetIds);
    if (ids.length === 0) {
      return { prompt: input.prompt, referenceImages: input.messageImages, presets: [] };
    }

    const { valid, invalid } = ImageRequestAssembler.scan(root);
    const byId = new Map(valid.map((preset) => [preset.id, preset]));
    const presets: ImagePreset[] = [];
    for (const id of ids) {
      const preset = byId.get(id);
      if (preset) {
        presets.push(preset);
        continue;
      }
      const reason = invalid.get(id);
      if (reason) {
        throw new ImageRequestAssemblyError(`Image preset "${id}" is invalid: ${reason}`);
      }
      const available = valid.map((preset) => preset.id);
      const suffix = available.length > 0 ? ` Available: ${available.join(', ')}.` : ' No presets are available.';
      throw new ImageRequestAssemblyError(`Unknown image preset "${id}".${suffix}`);
    }

    return {
      prompt: renderPrompt(input.prompt, input.messageImages.length, presets),
      referenceImages: [...input.messageImages, ...presets.flatMap((preset) => preset.images)],
      presets,
    };
  }

  private static presetsRoot(): string {
    return join(getRepoRoot(), 'data', 'image-presets');
  }

  private static scan(root: string): { valid: ImagePreset[]; invalid: Map<string, string> } {
    const valid: ImagePreset[] = [];
    const invalid = new Map<string, string>();
    if (!existsSync(root)) {
      return { valid, invalid };
    }

    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (error) {
      logger.warn(
        `[ImageRequestAssembler] Failed to read ${root}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return { valid, invalid };
    }

    for (const id of entries) {
      if (!PRESET_ID_PATTERN.test(id)) {
        continue;
      }
      const dir = join(root, id);
      try {
        if (!statSync(dir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      try {
        valid.push(ImageRequestAssembler.readPreset(id, dir));
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        invalid.set(id, reason);
        logger.debug(`[ImageRequestAssembler] Skipping preset ${id}: ${reason}`);
      }
    }

    valid.sort((a, b) => a.id.localeCompare(b.id));
    return { valid, invalid };
  }

  private static readPreset(id: string, dir: string): ImagePreset {
    const manifestPath = join(dir, 'preset.json');
    if (!existsSync(manifestPath)) {
      throw new ImageRequestAssemblyError('missing preset.json');
    }
    let parsed: ParsedPresetFile;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as ParsedPresetFile;
    } catch (error) {
      throw new ImageRequestAssemblyError(
        `preset.json is not valid JSON (${error instanceof Error ? error.message : 'parse error'})`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ImageRequestAssemblyError('preset.json must be an object');
    }

    const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
    if (!description) {
      throw new ImageRequestAssemblyError('description is required');
    }
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : id;
    const aliases = readAliases(parsed.aliases).filter((alias) => alias !== name);
    const images = resolvePresetImages(id, dir, parsed.images);

    return { id, name, aliases, description, images, imageCount: images.length };
  }
}

function readAliases(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ImageRequestAssemblyError('aliases must be an array of strings');
  }
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new ImageRequestAssemblyError('aliases must be an array of strings');
    }
    const alias = entry.trim();
    if (seen.has(alias)) {
      continue;
    }
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases;
}

function normalizePresetIds(ids: string[] | undefined): string[] {
  if (!ids?.length) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') {
      throw new ImageRequestAssemblyError('preset id must be a string');
    }
    const id = raw.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function resolvePresetImages(id: string, dir: string, declared: unknown): string[] {
  const presetRoot = realpathSync(dir);
  if (declared === undefined) {
    const found = readdirSync(presetRoot)
      .filter((name) => IMAGE_EXTENSIONS.has(extensionOf(name)))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => containImage(id, presetRoot, name));
    if (found.length === 0) {
      throw new ImageRequestAssemblyError('no reference images in the preset directory');
    }
    return found;
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new ImageRequestAssemblyError('images must be a non-empty array of relative paths');
  }
  return declared.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new ImageRequestAssemblyError('images must be a non-empty array of relative paths');
    }
    return containImage(id, presetRoot, entry.trim());
  });
}

function containImage(id: string, presetRoot: string, relativeName: string): string {
  if (isAbsolute(relativeName) || relativeName.includes('\0')) {
    throw new ImageRequestAssemblyError(`image "${relativeName}" must be a relative path inside the preset directory`);
  }
  if (!IMAGE_EXTENSIONS.has(extensionOf(relativeName))) {
    throw new ImageRequestAssemblyError(`image "${relativeName}" is not a supported image file`);
  }
  const resolved = resolve(presetRoot, relativeName);
  if (!isInside(presetRoot, resolved)) {
    throw new ImageRequestAssemblyError(`image "${relativeName}" escapes the preset directory`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new ImageRequestAssemblyError(`missing image "${relativeName}"`);
  }
  const real = realpathSync(resolved);
  if (!isInside(presetRoot, real)) {
    throw new ImageRequestAssemblyError(`image "${relativeName}" escapes the preset directory`);
  }
  return real;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function renderPrompt(prompt: string, messageImageCount: number, presets: ImagePreset[]): string {
  const lines = [
    '精确复现下列元素，外观以对应参考图为准。',
    `参考图顺序：用户消息中的 ${messageImageCount} 张在前，随后按下列顺序附上每个 preset 的参考图。`,
  ];
  for (const preset of presets) {
    lines.push('', `[preset:${preset.id}] ${preset.name}（${preset.images.length} 张参考图）`, preset.description);
  }
  return `${prompt.trim()}\n\n${lines.join('\n')}`;
}

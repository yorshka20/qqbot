// Hand-written memory: one manual.txt per slot, the source of truth for the manual layer.
//
// Layout: {memory.dir}/{groupId}/{userId|_global_}/manual.txt. People write these (webui or an
// editor); no LLM job ever does. Read on every use, so an edit takes effect on the next reply.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { GROUP_MEMORY_USER_ID } from '../model/constants';
import { type ManualFact, parseManualFacts } from './manualFormat';

const DEFAULT_MEMORY_DIR = 'data/memory';
const GROUP_MEMORY_DIRNAME = '_global_';
const MANUAL_FILENAME = 'manual.txt';

export interface ManualSlot {
  groupId: string;
  userId: string;
}

@singleton()
export class ManualMemoryStore {
  private readonly basePath: string;

  constructor(@inject(DITokens.CONFIG) config: Config) {
    this.basePath = resolve(process.cwd(), config.getMemoryConfig().dir ?? DEFAULT_MEMORY_DIR);
  }

  private path(groupId: string, userId: string): string {
    const dirName = userId === GROUP_MEMORY_USER_ID ? GROUP_MEMORY_DIRNAME : sanitizePathSegment(userId);
    return join(this.basePath, sanitizePathSegment(groupId), dirName, MANUAL_FILENAME);
  }

  getText(groupId: string, userId: string): string {
    try {
      return readFileSync(this.path(groupId, userId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('[ManualMemoryStore] read failed:', err);
      }
      return '';
    }
  }

  getFacts(groupId: string, userId: string): ManualFact[] {
    return parseManualFacts(this.getText(groupId, userId));
  }

  async save(groupId: string, userId: string, content: string): Promise<void> {
    const path = this.path(groupId, userId);
    await mkdir(dirname(path), { recursive: true });
    const trimmed = content.trim();
    await writeFile(path, trimmed ? `${trimmed}\n` : '', 'utf-8');
  }

  /** Every slot whose manual.txt has content. */
  listSlots(): ManualSlot[] {
    if (!existsSync(this.basePath)) {
      return [];
    }
    const slots: ManualSlot[] = [];
    for (const groupEntry of readdirSync(this.basePath, { withFileTypes: true })) {
      if (!groupEntry.isDirectory()) {
        continue;
      }
      const groupId = groupEntry.name;
      for (const slotEntry of readdirSync(join(this.basePath, groupId), { withFileTypes: true })) {
        if (!slotEntry.isDirectory()) {
          continue;
        }
        const userId = slotEntry.name === GROUP_MEMORY_DIRNAME ? GROUP_MEMORY_USER_ID : slotEntry.name;
        if (this.getText(groupId, userId).trim()) {
          slots.push({ groupId, userId });
        }
      }
    }
    return slots;
  }
}

/** Allow only alphanumeric and underscore; replace other chars with _. */
function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_]/g, '_');
}

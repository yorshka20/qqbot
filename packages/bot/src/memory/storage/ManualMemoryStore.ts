// Hand-written memory: one manual.txt per slot, the source of truth for the manual layer.
//
// Layout: {memory.dir}/{groupId}/{userId|_global_}/manual.txt. People write these (webui or an
// editor); no LLM job ever does. Read on every use. The vector index follows the files through
// `MemoryIndexSync`, which watches this directory.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inject, singleton } from 'tsyringe';
import { v5 as uuidv5 } from 'uuid';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { GROUP_MEMORY_USER_ID } from '../model/constants';
import { type ManualFact, parseManualFacts } from './manualFormat';

const DEFAULT_MEMORY_DIR = 'data/memory';
const GROUP_MEMORY_DIRNAME = '_global_';
const MANUAL_FILENAME = 'manual.txt';
const MANUAL_FACT_ID_NAMESPACE = '6f1d3c2a-8b4e-4f7a-9c5d-2e8b1a7f4c90';

export interface ManualSlot {
  groupId: string;
  userId: string;
}

/**
 * A manual line with the identity the index needs. The id is derived from the slot, scope and
 * text, so an unchanged line keeps its point and an edited line is a new fact.
 */
export interface ManualMemoryFact extends ManualFact {
  id: string;
  groupId: string;
  userId: string;
}

@singleton()
export class ManualMemoryStore {
  private readonly basePath: string;

  constructor(@inject(DITokens.CONFIG) config: Config) {
    this.basePath = resolve(process.cwd(), config.getMemoryConfig().dir ?? DEFAULT_MEMORY_DIR);
  }

  get directory(): string {
    return this.basePath;
  }

  private path(groupId: string, userId: string): string {
    const dirName = userId === GROUP_MEMORY_USER_ID ? GROUP_MEMORY_DIRNAME : sanitizePathSegment(userId);
    return join(this.basePath, sanitizePathSegment(groupId), dirName, MANUAL_FILENAME);
  }

  /** The slot a path under `directory` belongs to, when it is a slot's manual.txt. */
  slotAt(relativePath: string): ManualSlot | null {
    const parts = relativePath.split(/[\\/]/);
    if (parts.length !== 3 || parts[2] !== MANUAL_FILENAME) {
      return null;
    }
    return { groupId: parts[0], userId: parts[1] === GROUP_MEMORY_DIRNAME ? GROUP_MEMORY_USER_ID : parts[1] };
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

  /** The slot's facts in file order; a line repeated under the same scope appears once. */
  getFacts(groupId: string, userId: string): ManualMemoryFact[] {
    const facts = new Map<string, ManualMemoryFact>();
    for (const fact of parseManualFacts(this.getText(groupId, userId))) {
      const id = uuidv5([groupId, userId, fact.scope, fact.content].join('\n'), MANUAL_FACT_ID_NAMESPACE);
      if (!facts.has(id)) {
        facts.set(id, { id, groupId, userId, ...fact });
      }
    }
    return [...facts.values()];
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

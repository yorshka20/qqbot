import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CORE_DNA, loadCoreDNA } from '../data/CoreDNALoader';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `core-dna-test-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeCoreDNA(personaId: string, content: unknown): Promise<void> {
  const dir = path.join(tmpDir, 'persona', personaId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'core-dna.json'), JSON.stringify(content, null, 2), 'utf-8');
}

describe('loadCoreDNA', () => {
  it('returns DEFAULT_CORE_DNA when file does not exist', async () => {
    const result = await loadCoreDNA({ dataDir: tmpDir, personaId: 'nonexistent' });
    expect(result).toEqual(DEFAULT_CORE_DNA);
    expect(result.id).toBe('default');
    expect(result.modulation.spatial.postureLeanBaseline).toBe(0.08);
  });

  it('loads and parses a valid core-dna.json', async () => {
    const validDNA = {
      ...DEFAULT_CORE_DNA,
      id: 'test',
      displayName: 'Test Persona',
    };
    await writeCoreDNA('test', validDNA);
    const result = await loadCoreDNA({ dataDir: tmpDir, personaId: 'test' });
    expect(result.id).toBe('test');
    expect(result.displayName).toBe('Test Persona');
    expect(result.modulation.spatial.gazeDistributionBaseline.camera).toBe(0.6);
    expect(result.modulation.actionPref.forbiddenActions).toEqual([]);
    expect(result.modulation.ambient.gainScale).toBe(1.0);
  });

  it('throws on unknown key (strict mode rejects extra fields)', async () => {
    const withExtraField = {
      ...DEFAULT_CORE_DNA,
      id: 'strict-test',
      modulation: {
        ...DEFAULT_CORE_DNA.modulation,
        spatial: {
          ...DEFAULT_CORE_DNA.modulation.spatial,
          unknownField: 1,
        },
      },
    };
    await writeCoreDNA('strict-test', withExtraField);

    let caught: unknown;
    try {
      await loadCoreDNA({ dataDir: tmpDir, personaId: 'strict-test' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
  });

  it('throws when bigFive value is out of range', async () => {
    const outOfRange = {
      ...DEFAULT_CORE_DNA,
      id: 'range-test',
      identity: {
        ...DEFAULT_CORE_DNA.identity,
        bigFive: {
          ...DEFAULT_CORE_DNA.identity.bigFive,
          openness: 2.5,
        },
      },
    };
    await writeCoreDNA('range-test', outOfRange);

    let caught: unknown;
    try {
      await loadCoreDNA({ dataDir: tmpDir, personaId: 'range-test' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
  });
});

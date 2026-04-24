/**
 * Regenerates `assets/vrm-extend-action-map.json` from every clip JSON
 * under `assets/clips/vrm/` (except `test-fixture.json`).
 * Run: `bun run scripts/generate-vrm-extend-action-map.ts` from `packages/avatar`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const vrmClipsDir = join(__dir, '../assets/clips/vrm');
const outPath = join(__dir, '../assets/vrm-extend-action-map.json');
const SKIP = new Set(['test-fixture.json']);

type ClipFile = { duration?: number };

function fileToActionKey(file: string): string {
  const base = basename(file, '.json');
  const slug = base
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `vrm_${slug || 'unnamed'}`;
}

const entries: Record<string, ReturnType<typeof makeEntry>> = {};
const usedKeys = new Set<string>();

function makeEntry(clipRel: string, durationMs: number) {
  return {
    kind: 'clip' as const,
    category: 'movement',
    modelSupport: 'vrm' as const,
    description: `VRM clip: ${clipRel.replace(/^clips\/vrm\//, '')}`,
    clip: clipRel,
    defaultDuration: durationMs,
  };
}

const files = readdirSync(vrmClipsDir).filter((f) => f.endsWith('.json') && !SKIP.has(f));
files.sort((a, b) => a.localeCompare(b, 'en'));

for (const f of files) {
  const abs = join(vrmClipsDir, f);
  const raw = readFileSync(abs, 'utf8');
  let durationMs: number;
  try {
    const j = JSON.parse(raw) as ClipFile;
    if (typeof j.duration === 'number' && Number.isFinite(j.duration) && j.duration > 0) {
      durationMs = Math.round(j.duration * 1000);
    } else {
      durationMs = 3000;
    }
  } catch {
    durationMs = 3000;
  }
  let key = fileToActionKey(f);
  if (usedKeys.has(key)) {
    let n = 2;
    while (usedKeys.has(`${key}__${n}`)) n++;
    key = `${key}__${n}`;
    console.warn(`[generate-vrm-extend] duplicate file slug → using "${key}" for ${f}`);
  }
  usedKeys.add(key);
  entries[key] = makeEntry(`clips/vrm/${f}`, durationMs);
}

const body = JSON.stringify(entries, null, 2) + '\n';
writeFileSync(outPath, body, 'utf8');
console.log(
  `[generate-vrm-extend] Wrote ${Object.keys(entries).length} actions → ${outPath} (re-run after adding clips)`,
);

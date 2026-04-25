/**
 * Scans `assets/clips/vrm/` for clips not yet referenced by any
 * `assets/extend/*.json` file and writes stub entries for them into
 * `assets/extend/_unsorted.json`.
 *
 * Existing per-category extend files are NEVER touched — descriptions and
 * categories filled by hand stay intact. After running this, triage the
 * stubs: move each entry into the appropriate category file (and write a
 * real description), then delete `_unsorted.json` (or leave it empty).
 *
 * Run from `packages/avatar`:
 *   bun run scripts/generate-vrm-extend-action-map.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const vrmClipsDir = join(__dir, '../assets/clips/vrm');
const extendDir = join(__dir, '../assets/extend');
const unsortedPath = join(extendDir, '_unsorted.json');
const SKIP_FILES = new Set(['test-fixture.json']);

type ClipFile = { duration?: number };
type ClipRef = { clip?: string | string[] };
type ExtendEntry = ClipRef | ClipRef[];

function fileToActionKey(file: string): string {
  const base = basename(file, '.json');
  const slug = base
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `vrm_${slug || 'unnamed'}`;
}

function collectReferencedClips(): Set<string> {
  const refs = new Set<string>();
  if (!existsSync(extendDir)) return refs;
  const files = readdirSync(extendDir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const raw = readFileSync(join(extendDir, f), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, ExtendEntry | string[]>;
    // `_archive.json` (or any `_archive` key) lists paths intentionally
    // dropped from the action map — treat as referenced so the generator
    // doesn't keep re-stubbing them.
    const archive = parsed._archive;
    if (Array.isArray(archive)) {
      for (const p of archive) {
        if (typeof p === 'string') refs.add(p);
      }
    }
    for (const [key, entry] of Object.entries(parsed)) {
      if (key.startsWith('_')) continue;
      const variants = Array.isArray(entry) ? entry : [entry];
      for (const v of variants) {
        if (!v || typeof v !== 'object' || !('clip' in v)) continue;
        const paths = Array.isArray(v.clip) ? v.clip : v.clip ? [v.clip] : [];
        for (const p of paths) refs.add(p);
      }
    }
  }
  return refs;
}

function durationMsOf(absPath: string): number {
  try {
    const j = JSON.parse(readFileSync(absPath, 'utf8')) as ClipFile;
    if (typeof j.duration === 'number' && Number.isFinite(j.duration) && j.duration > 0) {
      return Math.round(j.duration * 1000);
    }
  } catch {
    /* fall through */
  }
  return 3000;
}

const referenced = collectReferencedClips();
const stubs: Record<string, unknown> = {};
const usedKeys = new Set<string>();

const files = readdirSync(vrmClipsDir).filter((f) => f.endsWith('.json') && !SKIP_FILES.has(f));
files.sort((a, b) => a.localeCompare(b, 'en'));

for (const f of files) {
  const rel = `clips/vrm/${f}`;
  if (referenced.has(rel)) continue;
  const abs = join(vrmClipsDir, f);
  let key = fileToActionKey(f);
  if (usedKeys.has(key)) {
    let n = 2;
    while (usedKeys.has(`${key}__${n}`)) n++;
    key = `${key}__${n}`;
  }
  usedKeys.add(key);
  stubs[key] = {
    kind: 'clip',
    category: 'TODO',
    modelSupport: 'vrm',
    description: `TODO: review and describe (${f})`,
    clip: rel,
    defaultDuration: durationMsOf(abs),
  };
}

if (Object.keys(stubs).length === 0) {
  if (existsSync(unsortedPath)) {
    writeFileSync(unsortedPath, '{}\n', 'utf8');
  }
  console.log('[generate-vrm-extend] no unreferenced clips — nothing to stub.');
} else {
  writeFileSync(unsortedPath, `${JSON.stringify(stubs, null, 2)}\n`, 'utf8');
  console.log(
    `[generate-vrm-extend] wrote ${Object.keys(stubs).length} stub(s) → ${unsortedPath}; triage them into the appropriate per-category file.`,
  );
}

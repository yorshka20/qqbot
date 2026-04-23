#!/usr/bin/env bun
/**
 * Dev probe: dump per-hop viseme weights for a WAV / MP3 / raw-PCM file.
 *
 * Two output modes:
 *   (default) — terminal pretty-print with ASCII bar per frame for eyeballing.
 *   --csv     — CSV on stdout: t_ms,rms,aa,ih,ee,oh,ou,dominant  (pipe to a plotter).
 *
 * Usage:
 *   bun run packages/avatar/scripts/probe-visemes.ts <file.wav> [--hop 20]
 *   bun run packages/avatar/scripts/probe-visemes.ts <file.wav> --csv > out.csv
 *   bun run packages/avatar/scripts/probe-visemes.ts <file.pcm> --pcm-sr 32000
 *
 * Intended for calibrating DEFAULT_VISEME_CENTROIDS against your actual TTS
 * output. Run on a few representative utterances, watch the "dom" column —
 * if a whole 你好/再见 only ever shows `aa` or `ih` as dominant, centroids
 * need tuning.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { decodeToMonoPcm } from '../src/compiler/audio/decodeToMonoPcm';
import { type VisemeName, VisemeStreamer } from '../src/compiler/audio/visemeEstimation';

const VISEMES: readonly VisemeName[] = ['aa', 'ih', 'ee', 'oh', 'ou'];

interface CliArgs {
  path: string;
  hopMs: number;
  csv: boolean;
  dumpH: boolean;
  pcmSampleRate: number | null;
  centroids: Partial<Record<VisemeName, number>>;
  lowCenterHz: number | null;
  highCenterHz: number | null;
  q: number | null;
  temperature: number | null;
  preEmphasis: boolean;
}

function parseCentroids(spec: string): Partial<Record<VisemeName, number>> {
  const out: Partial<Record<VisemeName, number>> = {};
  for (const pair of spec.split(',')) {
    const [k, v] = pair.split('=');
    if (!k || !v) continue;
    const name = k.trim() as VisemeName;
    if (!VISEMES.includes(name)) {
      console.error(`unknown viseme "${name}" (must be one of ${VISEMES.join(', ')})`);
      process.exit(2);
    }
    out[name] = Number(v);
  }
  return out;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    path: '',
    hopMs: 20,
    csv: false,
    dumpH: false,
    pcmSampleRate: null,
    centroids: {},
    lowCenterHz: null,
    highCenterHz: null,
    q: null,
    temperature: null,
    preEmphasis: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') args.csv = true;
    else if (a === '--dump-h') args.dumpH = true;
    else if (a === '--hop') args.hopMs = Number(argv[++i]);
    else if (a === '--pcm-sr') args.pcmSampleRate = Number(argv[++i]);
    else if (a === '--centroid') args.centroids = parseCentroids(argv[++i]);
    else if (a === '--low-hz') args.lowCenterHz = Number(argv[++i]);
    else if (a === '--high-hz') args.highCenterHz = Number(argv[++i]);
    else if (a === '--q') args.q = Number(argv[++i]);
    else if (a === '--temperature') args.temperature = Number(argv[++i]);
    else if (a === '--no-pre-emphasis') args.preEmphasis = false;
    else if (!args.path) args.path = a;
  }
  if (!args.path) {
    console.error(
      [
        'usage: probe-visemes.ts <file> [flags]',
        '',
        'flags:',
        '  --hop <ms>                   hop duration (default 20)',
        '  --csv                        CSV output (t_ms,rms,aa,ih,ee,oh,ou,h,dom)',
        '  --dump-h                     h-axis histogram (voiced frames) for centroid calibration',
        '  --pcm-sr <Hz>                sample rate for raw .pcm/.raw input',
        '  --centroid oh=0.13,aa=0.3    override viseme centroids on h axis',
        '  --low-hz <Hz>                low-band center freq (default 500)',
        '  --high-hz <Hz>               high-band center freq (default 2000)',
        '  --q <Q>                      biquad Q factor (default 1.4)',
        '  --temperature <t>            softmax temperature (default 0.12)',
        '  --no-pre-emphasis            disable pre-emphasis (A/B against default)',
      ].join('\n'),
    );
    process.exit(2);
  }
  return args;
}

function guessMime(path: string, args: CliArgs): { mime: string; pcmSr: number | null } {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.wav':
      return { mime: 'audio/wav', pcmSr: null };
    case '.mp3':
      return { mime: 'audio/mpeg', pcmSr: null };
    case '.pcm':
    case '.raw': {
      if (!args.pcmSampleRate) {
        console.error('raw PCM input requires --pcm-sr (sample rate in Hz)');
        process.exit(2);
      }
      return { mime: 'audio/pcm', pcmSr: args.pcmSampleRate };
    }
    default:
      console.error(`unknown extension "${ext}" — use --pcm-sr for raw PCM`);
      process.exit(2);
  }
}

function dominantViseme(w: Record<VisemeName, number>): VisemeName | '—' {
  let best: VisemeName | '—' = '—';
  let bestVal = 0;
  for (const v of VISEMES) {
    if (w[v] > bestVal) {
      bestVal = w[v];
      best = v;
    }
  }
  return best;
}

function bar(val: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(val * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { mime, pcmSr } = guessMime(args.path, args);

  const bytes = new Uint8Array(readFileSync(args.path));
  const { pcm, sampleRate } = await decodeToMonoPcm(bytes, mime, pcmSr ? { sampleRate: pcmSr } : undefined);

  const streamer = new VisemeStreamer({
    hopMs: args.hopMs,
    preEmphasis: args.preEmphasis,
    ...(Object.keys(args.centroids).length > 0 && { centroids: args.centroids }),
    ...(args.lowCenterHz !== null && { lowCenterHz: args.lowCenterHz }),
    ...(args.highCenterHz !== null && { highCenterHz: args.highCenterHz }),
    ...(args.q !== null && { q: args.q }),
    ...(args.temperature !== null && { temperature: args.temperature }),
  });
  const frames = streamer.push(pcm, sampleRate);
  const tail = streamer.flush();
  if (tail) frames.push(tail);

  if (args.csv) {
    console.log('t_ms,rms,aa,ih,ee,oh,ou,h,dominant');
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const t = i * args.hopMs;
      const dom = dominantViseme(f.weights);
      const w = f.weights;
      console.log(
        `${t},${f.rms.toFixed(4)},${w.aa.toFixed(4)},${w.ih.toFixed(4)},${w.ee.toFixed(4)},${w.oh.toFixed(4)},${w.ou.toFixed(4)},${f.h.toFixed(4)},${dom === '—' ? '' : dom}`,
      );
    }
    return;
  }

  if (args.dumpH) {
    // Histogram of h across voiced frames only. Raw list printed after
    // the histogram so callers can pipe through `awk` / sort / quantile
    // to pick exact centroid values.
    const hs: number[] = [];
    for (const f of frames) {
      if (f.rms >= 0.01) hs.push(f.h);
    }
    const bins = 20;
    const counts = new Array<number>(bins).fill(0);
    for (const h of hs) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(h * bins)));
      counts[idx]++;
    }
    const max = Math.max(1, ...counts);
    console.log(`h-axis histogram — ${hs.length} voiced frames (preEmphasis=${args.preEmphasis})`);
    console.log('h-range        count   bar');
    for (let i = 0; i < bins; i++) {
      const lo = (i / bins).toFixed(2);
      const hi = ((i + 1) / bins).toFixed(2);
      const n = counts[i];
      const pct = ((n / Math.max(hs.length, 1)) * 100).toFixed(1);
      console.log(`  ${lo}–${hi}  ${String(n).padStart(5)}  ${bar(n / max, 40)}  ${pct.padStart(5)}%`);
    }
    // Quantile summary — directly usable for centroid calibration.
    const sorted = [...hs].sort((a, b) => a - b);
    const qAt = (q: number): number => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
      return sorted[idx];
    };
    console.log('\nSuggested centroids (10/30/50/70/90 quantiles of h):');
    console.log(`  oh=${qAt(0.1).toFixed(3)}`);
    console.log(`  ou=${qAt(0.3).toFixed(3)}`);
    console.log(`  aa=${qAt(0.5).toFixed(3)}`);
    console.log(`  ih=${qAt(0.7).toFixed(3)}`);
    console.log(`  ee=${qAt(0.9).toFixed(3)}`);
    return;
  }

  // Pretty print
  const durMs = (pcm.length / sampleRate) * 1000;
  console.log(
    `file: ${basename(args.path)}  —  ${sampleRate} Hz, ${durMs.toFixed(1)} ms, ${frames.length} frames (hop=${args.hopMs} ms)`,
  );
  console.log(`${' t_ms │  rms  │ dom │ '.padEnd(25)}  aa   ih   ee   oh   ou  │ dominant bar`);
  console.log('─'.repeat(80));

  const histogram: Record<string, number> = { aa: 0, ih: 0, ee: 0, oh: 0, ou: 0, '—': 0 };
  let maxRms = 0;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const t = i * args.hopMs;
    const dom = dominantViseme(f.weights);
    const w = f.weights;
    if (f.rms > maxRms) maxRms = f.rms;
    histogram[dom]++;

    const topVal = dom !== '—' ? w[dom] : 0;
    console.log(
      `${String(t).padStart(5)} │ ${f.rms.toFixed(2)} │ ${dom.padEnd(3)} │ ` +
        `${w.aa.toFixed(2)} ${w.ih.toFixed(2)} ${w.ee.toFixed(2)} ${w.oh.toFixed(2)} ${w.ou.toFixed(2)} │ ` +
        `${bar(topVal)} ${dom !== '—' ? dom : ''}`,
    );
  }

  console.log('─'.repeat(80));
  console.log('\nDominant viseme distribution (voiced frames only):');
  const voiced = frames.length - histogram['—'];
  for (const v of VISEMES) {
    const n = histogram[v];
    const pct = voiced > 0 ? ((n / voiced) * 100).toFixed(1) : '0.0';
    console.log(`  ${v}: ${String(n).padStart(4)}  (${pct.padStart(5)}%)  ${bar(n / Math.max(voiced, 1))}`);
  }
  console.log(`  silence: ${histogram['—']} frames`);
  console.log(`\npeak RMS: ${maxRms.toFixed(4)}`);
}

main().catch((err) => {
  console.error('error:', err);
  process.exit(1);
});

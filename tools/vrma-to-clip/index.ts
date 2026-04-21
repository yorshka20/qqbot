import { readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, extname, join } from 'node:path';
import { convert } from './src/convert.js';

const args = process.argv.slice(2);
const quietIdx = args.indexOf('-q') !== -1 ? args.indexOf('-q') : args.indexOf('--quiet');
const quiet = quietIdx !== -1;

// Remove -q / --quiet flag from positional args
const positionals = args.filter((a) => a !== '-q' && a !== '--quiet');

if (positionals.length === 0) {
  process.stderr.write(
    'Usage: bun run tools/vrma-to-clip/index.ts <input.vrma|.glb> [output.json] [-q|--quiet]\n',
  );
  process.exit(1);
}

const inputPath = positionals[0];
const outputPath =
  positionals[1] ?? join(dirname(inputPath), basename(inputPath, extname(inputPath)) + '.json');

const id = basename(inputPath, extname(inputPath));

const logLevel = process.env['LOG_LEVEL'];

try {
  if (!quiet) process.stdout.write(`converting ${inputPath} → ${outputPath}\n`);

  const buf = await readFile(inputPath);
  const clip = await convert(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), id);

  const json = JSON.stringify(clip, null, 2);
  await writeFile(outputPath, json, 'utf-8');

  const boneTracks = clip.tracks.filter(
    (t) => !t.channel.startsWith('vrm.expression.') && !t.channel.startsWith('vrm.root.'),
  );
  const exprTracks = clip.tracks.filter((t) => t.channel.startsWith('vrm.expression.'));
  const rootTracks = clip.tracks.filter((t) => t.channel.startsWith('vrm.root.'));
  const totalKeyframes = clip.tracks.reduce((sum, t) => sum + t.keyframes.length, 0);
  const outputSizeKB = (json.length / 1024).toFixed(1);

  // Count quat vs scalar-axis bone tracks for the summary line
  const quatBoneTracks = boneTracks.filter((t) => t.kind === 'quat');
  const scalarAxisTracks = boneTracks.filter((t) => t.kind !== 'quat');

  const boneNames = boneTracks
    .map((t) => t.channel)
    .slice(0, 8)
    .join(', ');
  const boneEllipsis = boneTracks.length > 8 ? '...' : '';
  const exprNames = exprTracks.map((t) => t.channel.replace('vrm.expression.', '')).join(', ');
  const hasRoot = rootTracks.length > 0;

  if (quiet) {
    process.stdout.write(
      `done. duration=${clip.duration.toFixed(3)}s bones=${boneTracks.length} expr=${exprTracks.length} root=${hasRoot ? 'yes' : 'no'} kf=${totalKeyframes} size=${outputSizeKB}KB\n`,
    );
  } else {
    process.stdout.write(`  duration: ${clip.duration.toFixed(3)}s\n`);
    process.stdout.write(
      `  bone tracks: ${boneTracks.length} (${boneNames}${boneEllipsis}) — ${quatBoneTracks.length} quat, ${scalarAxisTracks.length} scalar-axes\n`,
    );
    process.stdout.write(
      `  expression tracks: ${exprTracks.length}${exprNames ? ` (${exprNames})` : ''}\n`,
    );
    process.stdout.write(`  root motion: ${hasRoot ? 'yes' : 'no'}\n`);
    process.stdout.write(`  keyframes total: ${totalKeyframes}\n`);
    process.stdout.write(`  output size: ${outputSizeKB}KB\n`);
    process.stdout.write('done.\n');
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (logLevel === 'debug' && err instanceof Error && err.stack) {
    process.stderr.write(`vrma-to-clip: ${err.stack}\n`);
  } else {
    process.stderr.write(`vrma-to-clip: ${message}\n`);
  }
  process.exit(1);
}

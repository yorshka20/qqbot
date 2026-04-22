import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create `directory` (recursive) and write `fileName` inside it. Shared with
 * bot `ResourceDownloader` for on-disk saves (TTS debug export, image downloads, …).
 */
export function writeFileUnderDirectory(directory: string, fileName: string, data: Buffer | Uint8Array): string {
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, fileName);
  writeFileSync(filePath, data);
  return filePath;
}

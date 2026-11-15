import { fromRepoRoot } from '@qqbot/shared';

/** Where the bot serves the built admin WebUI from; `bun run build:admin` installs it here. */
export function webuiDir(): string {
  return fromRepoRoot('data/webui');
}

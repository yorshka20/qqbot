#!/usr/bin/env bash
# Run on every PM2 start/restart, crash restarts included: start the bot on the code already
# checked out. Updating code and dependencies is `bun run deploy`, never a restart.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
exec bun run packages/bot/src/index.ts

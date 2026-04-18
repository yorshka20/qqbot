#!/usr/bin/env bash
# Run on every PM2 start/restart: pull, then start bot. Bun auto-installs deps as needed.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
git pull
exec bun run packages/bot/src/index.ts

#!/bin/bash
# One-key: git pull, install (root + webui), then PM2 start both (same as dev: bun run src/index.ts + webui dev).

set -e
cd "$(dirname "$0")"
git pull
bun install
(cd webui && bun install)

pm2 delete qq-bot 2>/dev/null || true
pm2 delete qq-bot-ui 2>/dev/null || true
pm2 start "$(pwd)/ecosystem.config.cjs"

echo "Done. pm2 status | pm2 logs"

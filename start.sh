#!/bin/bash
# One-key for manual use: stop PM2 apps, git pull, install (root + webui), then PM2 start.
# For in-bot restart use /restart (which runs "pm2 restart" so ecosystem scripts do pull+install).

set -e
cd "$(dirname "$0")"

pm2 delete qq-bot 2>/dev/null || true
pm2 delete qq-bot-ui 2>/dev/null || true

git pull
bun install

pm2 start "$(pwd)/ecosystem.config.cjs"

echo "Done. pm2 status | pm2 logs"

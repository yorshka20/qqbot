#!/bin/bash
# One-key for manual use: stop the PM2-managed bot, install deps for the current checkout, then
# PM2 start. It does not pull: updating to the latest code is `bun run deploy`.
# Only the bot is daemonized by PM2. The WebUI is a local client managed separately
# by scripts/ui.sh (bun run ui:start). For in-bot restart use /restart.

set -e
cd "$(dirname "$0")"

pm2 delete qq-bot 2>/dev/null || true

bun install

pm2 start "$(pwd)/ecosystem.config.cjs"

echo "Bot started. pm2 status | pm2 logs"
echo "WebUI is not managed by PM2 — start it with: bun run ui:start"

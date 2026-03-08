#!/bin/bash
# One-key start: git pull, install, then PM2 starts bot + webui (qq-bot, qq-bot-ui).

set -e
git pull && bun install

# Remove old PM2 apps if present, then start from ecosystem (bot + ui as two apps)
pm2 delete qq-bot 2>/dev/null || true
pm2 delete qq-bot-ui 2>/dev/null || true
pm2 start ecosystem.config.cjs

echo "Done. Bot and UI are running under PM2. Use: pm2 status | pm2 logs | pm2 restart all"

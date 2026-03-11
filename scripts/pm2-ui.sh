#!/usr/bin/env bash
# Run on every PM2 start/restart: pull, install, then start webui dev. So remote fixes are picked up on retry.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull
bun install
(cd webui && bun install)
cd webui && exec bun run dev

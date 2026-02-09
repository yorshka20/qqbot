#!/bin/bash

git pull && bun install

# use exec to replace the current process, so that PM2 can directly monitor the bun process
exec bun run dev

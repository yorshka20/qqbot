# Monorepo

## Bun workspaces

- 启用：根 `package.json` 加 `"workspaces": ["packages/*"]`
- 本仓实测 bun 版本：1.3.6
- 调用子包脚本：`bun run --filter <name> <script>`（示例：`bun run --filter @qqbot/webui dev`）
  - 若 `--filter` 不可用，退化为 `cd packages/<name> && bun run <script>`（本仓是否退化：NO — bun 1.3.6 原生支持）
- 根 `bun install` 会递归安装所有 `packages/*` 的依赖，不再需要 `cd packages/<name> && bun install`
- bun workspaces 使用 hoisting：子包依赖提升至根 `node_modules`，子包目录本身不会有独立的 `node_modules`（但根 `node_modules/@qqbot/webui` 是指向 `packages/webui` 的 symlink）

## Package locations
- `packages/webui/` — Vite + React 19 admin UI（package name: `@qqbot/webui`）
- `src/` — T1 未迁移，T2 会拆到 `packages/bot/`
- `src/avatar/` — T1 未迁移，T3 会拆到 `packages/avatar/`

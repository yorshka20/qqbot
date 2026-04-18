# Monorepo

## Bun workspaces

- 启用：根 `package.json` 加 `"workspaces": ["packages/*"]`
- 本仓实测 bun 版本：1.3.6
- 调用子包脚本：`bun run --filter <name> <script>`（示例：`bun run --filter @qqbot/webui dev`）
  - 若 `--filter` 不可用，退化为 `cd packages/<name> && bun run <script>`（本仓是否退化：NO — bun 1.3.6 原生支持）
- 根 `bun install` 会递归安装所有 `packages/*` 的依赖，不再需要 `cd packages/<name> && bun install`
- bun workspaces 使用 hoisting：子包依赖提升至根 `node_modules`，子包目录本身不会有独立的 `node_modules`（但根 `node_modules/@qqbot/webui` 是指向 `packages/webui` 的 symlink）

## Package locations (T2 完成后)
- `packages/webui/` — Vite + React 19 admin UI（`@qqbot/webui`）
- `packages/bot/` — Bot 核心代码（`@qqbot/bot`）：src/, types/, build.config.ts, scripts/
- `src/avatar/` — T2 未迁移，T3 会拆到 `packages/avatar/`

## 运行时资产 cwd 约定（关键）

**Bot 必须以仓库根目录为 cwd 启动**，否则 `config.jsonc`、`prompts/`、`data/`、`logs/` 等路径断裂。

- `dev` → `bun run packages/bot/src/index.ts`（不用 `--filter`）
- `smoke-test` → `NO_FILE_LOG=1 bun run packages/bot/src/cli/smoke-test.ts`（不用 `--filter`）
- `test` → `bun test packages/bot`（不用 `--filter`）
- `start` / PM2 → `exec bun run packages/bot/src/index.ts`（pm2-bot.sh 更新后）
- `bun run --filter @qqbot/bot` 会把 cwd 改为 `packages/bot/`，**破坏所有 `process.cwd()` 相对路径**

## TypeScript project references 配置

### 结构
```
tsconfig.base.json           # 共享 compilerOptions（无 noEmit/allowImportingTsExtensions）
tsconfig.json                # 根：files:[], references:[{path:./packages/bot},{path:./packages/webui}]
packages/bot/tsconfig.json   # composite:true, emitDeclarationOnly:true, outDir:./dist-types
```

### packages/bot/tsconfig.json 关键设置
- `extends: "../../tsconfig.base.json"` — 继承共享选项
- `composite: true` + `emitDeclarationOnly: true` — project references 模式
- `rootDir: "."` — 所有 include 文件必须在 packages/bot/ 下（不能 include 根级文件）
- `include: ["src/**/*", "types/**/*", "scripts/builds/**/*", "build.config.ts"]`
  - `scripts/moments/` 和 `scripts/migration/` 不含，因为它们导入根级 `scripts/lib/moments-common.ts`（跨 rootDir 限制）
- `allowImportingTsExtensions` 被移除（与 `emitDeclarationOnly` 不兼容）

### `@/` alias 新映射
- `packages/bot/tsconfig.json` 中：`"@/*": ["./src/*"]`, `"@/types/*": ["./types/*"]`
- 语义与原来相同，只是相对路径目标从仓库根的 `./src/` 变为 `packages/bot/` 的 `./src/`

### webui reference 注意
- `packages/webui/tsconfig.json` 是 references 形式（自身非 composite）
- `tsc -b` 在根级无报错，无需 drop webui reference

## PluginManager hardcoded path 修复

原代码：`join(process.cwd(), 'src', 'plugins', 'plugins')`
→ 迁移后 `process.cwd()` = 仓库根，但 `src/` 已移走，插件目录为 `packages/bot/src/plugins/plugins/`

修复：`join(import.meta.dir, 'plugins')`
- `import.meta.dir` 返回当前文件目录（`packages/bot/src/plugins/`），插件目录就是其下的 `plugins/`
- **与 cwd 无关**，更健壮

类似的 hardcoded path 检查点：任何使用 `process.cwd() + '/src/'` 的代码在迁移后都会断裂。

## 依赖归属

- **根 package.json**：只含 `devDependencies`（biome, concurrently, husky, prettier, typescript）
- **packages/bot/package.json**：所有 runtime deps（openai, tsyringe, winston, etc.）+ bot 专用 devDeps（@types/bun 等）
- **packages/webui/package.json**：webui 独立依赖

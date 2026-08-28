---
name: Config layout — config.d/ files vs config.example.jsonc
description: Live runtime config is split into config.d/<topic>.jsonc files; config.example.jsonc is a reference snapshot. When adding/changing config fields, edit the matching config.d/ file (and example as a documented reference).
type: feedback
originSessionId: 64ac1fac-e436-4da7-86c6-865f9b5c166f
modified: 2026-08-22T15:33:32.622Z
---
qqbot 的运行时配置已经**拆分**：

- **`config.d/<topic>.jsonc`**（如 `mind.jsonc` / `avatar.jsonc` / `ai.jsonc` / `bot.jsonc` / `plugins.jsonc` 等）—— **这是真正被加载的运行时配置**。修改 / 新增字段必须改这里。
- **`config.example.jsonc`** —— 单文件参考快照 / 文档样例；**不是**运行时入口。新增字段时**也要**同步更新对应位置（保持文档完整），但优先级在 config.d/<topic>.jsonc 之后。

**Why**: 2026-04-29 用户纠正——之前我以为 example 是唯一权威，错把 mind 新字段加到 example.jsonc，用户立即指出 "不是改example，是改config.d/mind.jsonc"。运行时实际从 config.d/ 读、example 只是 docs。

**How to apply**:
- 加 / 改字段：**两边必须同时改** —— `config.d/<topic>.jsonc`（运行时生效）+ `config.example.jsonc`（参考文档）。**不是 optional**。
- 不确定哪个 topic 文件 → `ls config.d/` 找最匹配的
- 单元测试 / smoke-test 跑 `config.d/`（merge 后的配置），所以**不动 config.d 的话 smoke-test 看不出问题**——这是为什么单改 example 不够
- 反向同理：只改了 example 用户运行时根本不知道有这个字段——2026-05-28 用户再次纠正："每次改 config.example 时必须同时改 config.d 里的真实配置文件，别只更新一遍"
- **2026-08-23 第三次犯**（加 ai.chat.maxToolRounds 只改了 example）。硬规则：任何 config 字段改动，动手顺序是 **先改 config.d/<topic>.jsonc，再顺手同步 example**——把 config.d 当第一现场，example 当收尾，就不会漏
- 新插件（plugins.jsonc 内的 list 项）：改 `config.d/plugins.jsonc` 加 entry；`config.example.jsonc` 的 plugins.list 也照样加注释 example

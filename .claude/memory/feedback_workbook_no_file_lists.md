---
name: feedback-workbook-no-file-lists
description: "Workbook daily entries must not contain \"涉及文件\" file lists — git log already records that"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f116f4a2-af34-44a2-9bea-d2edb222de66
  modified: 2026-08-22T15:25:11.368Z
---

Workbook（`.claude-workbook/` 日报）里**不要写"涉及文件"清单段**。

**Why:** git log / commit diff 已经完整记录了每次改动涉及的文件，日报再抄一遍是浪费空间的重复信息（2026-08-23 owner 明确指出）。

**How to apply:** 日报只写问题 / 根因 / 方案 / 验证 / 遗留；需要定位改动时用 commit hash 引用，让 git 当文件清单的单一来源。相关约定见 [[feedback-local-planning-artifacts]]。

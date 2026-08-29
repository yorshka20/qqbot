---
name: feedback-workbook-small-changes-skip
description: "Small changes don't get a workbook entry — reserve daily reports for work with real diagnosis/design content"
metadata:
  node_type: memory
  type: feedback
---

**小改动不写 workbook 日报**（2026-08-29 owner 明确指出）。

**Why:** 日报的价值在于记录问题 / 根因 / 方案这类无法从 diff 直接读出的分析；一个几行的排序调整、文案修改之类的小改动，commit message 本身已经说清楚了，再写日报是噪音。

**How to apply:** 只有包含真实诊断、设计取舍或多文件方案的工作才写日报；小改动靠 commit message 记录即可。与 [[feedback-workbook-no-file-lists]] 同源：workbook 不重复 git 已有的信息。

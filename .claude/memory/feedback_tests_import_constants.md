---
name: feedback-tests-import-constants
description: 测试不许复制实现里的预算/阈值常量——把常量 export 出来 import，fixture 规模由常量推导
metadata:
  type: feedback
---

测试里出现与实现相同的魔法数字（窗口预算、阈值、上限）时，不要在测试里再写一份字面量：把实现的常量 `export` 出来，测试 `import` 后用它推导 fixture 规模与断言。

**Why:** 2026-08-31 放宽 episode 窗口预算时，`EpisodeCacheManager.compression.test.ts` 里复制的旧数字（150/48/10k/100）导致 4 个测试失败、2 个用例在新门槛下"空转通过"（fixture 不再越界，断言 vacuous）。行为断言（"折到目标"、"不低于 floor"）本来就等于常量本身，复制数字只添加漂移风险，不增加检验力。

**How to apply:** 改预算/阈值类常量时同步检查测试是否 import 了它；新写测试时 fixture 用 `TRIGGER + margin` 形式推导，不写裸数字。参照 `EpisodeCacheManager.compression.test.ts`（2026-08-31 版）。

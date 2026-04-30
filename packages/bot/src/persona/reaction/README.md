# Reaction (System 1.5 — 条件反射层)

**未实现** — D/E ticket placeholder。

## 定位

Persona 三时间尺度的最快一档：

| 时间尺度 | 子模块 | 责任 |
|---|---|---|
| 毫秒级 | **Reaction**（本目录） | input pattern → 即时 valence/arousal Δ + 可选 reflex action |
| 秒级 | Mind（`../PersonaService.ts`，phenotype ODE） | 持续状态演化 |
| 分钟级 | Reflection（`../reflection/`，LLM） | 长程总结 / epigenetics 演化 |

## 输入

- `bible.md` 的 `## Triggers` 段（半结构化表）
- `bible.md` 的 `## Reflexes` 段（when X → do Y）

当前 [`CharacterBibleLoader`](../data/CharacterBibleLoader.ts) 已解析这两段为 raw 字符串字段（`triggersRaw` / `reflexesRaw`），但**无消费者**。

## 设计意图

- 纯代码（**不**调 LLM——条件反射不能秒级延迟）
- 订阅 stimulus → 按 Bible.Triggers 表 pattern match → 写 Phenotype delta
- 订阅特定 input pattern → 按 Bible.Reflexes 直接驱动 avatar action（绕过主 LLM 路径）

## 为什么先占位不实现

Schema 形态依赖**真实对话日志**反推。提前固化 schema 大概率重写。先在 DM 跑 1-2 周 mind / reflection 闭环，看哪些 Triggers / Reflexes pattern 真的稳定再做。

参考：[`docs/local/mind-system-design.md`](../../../../../docs/local/mind-system-design.md) Phase 4 / `.claude-learnings/mind.md` "Phase 3.6"。

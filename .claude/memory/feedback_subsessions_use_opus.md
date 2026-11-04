---
name: feedback_subsessions_use_opus
description: Sessions and subagents started from a Fable session run on Claude Opus 5.5, never on Fable
metadata:
  type: feedback
---

Any session or subagent this assistant starts (start_session, Agent tool, fresh or fork) runs on
`claude-opus-5-5`, not on Fable. Pass `model: "claude-opus-5-5"` explicitly on every start; if a
session was started without it, switch it with the session model setting at once.

**Why:** the owner's instruction (2026-11-04): "你的子session只能用opus5.5，别用fable". Fable is for
the owner's own conversation; delegated implementation and review work is Opus work.

**How to apply:** `start_session` → `model: "claude-opus-5-5"`; `Agent` → `model: "opus"`. Cluster
workers are governed by their templates in `config.d/cluster.jsonc`, not by this rule. See
[[feedback_console_ia_and_dispatch]].

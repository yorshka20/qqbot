# AGENTS.md

**Read [`CLAUDE.md`](./CLAUDE.md) first — it is the complete and authoritative instruction set for this repository.**

This file exists only so that agents which look for `AGENTS.md` (codex, gemini) find their way there. It is deliberately *not* maintained as a parallel copy, so anything you need is in `CLAUDE.md`:

- Development commands, and the build / typecheck / lint / **smoke-test** workflow that gates a change
- High-level architecture: the message pipeline, hook system, tool and plugin systems
- Code conventions and comment style
- Bug-fixing principle — root cause first, no stacking patches
- Git commit message convention
- The workbook / learnings workflow and roadmap maintenance

Accumulated user preferences and project facts live in [`.claude/memory/`](./.claude/memory/) — start from its `MEMORY.md` index.

**Do not add project rules to this file.** Put them where `CLAUDE.md` → "Where Conventions Live" says they belong.

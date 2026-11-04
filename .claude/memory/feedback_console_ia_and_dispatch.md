---
name: feedback_console_ia_and_dispatch
description: How the owner wants the cluster console designed and how console work is handed to the cluster (one spec, one ticket, no patch messages, owner does visual acceptance)
metadata:
  type: feedback
---

**Console design**: think like a frontend app (Claude app / Linear), not an admin panel. One primary object
(a task = one conversation); top level has only Inbox and the conversation list; everything else
(workers, templates, projects, concurrency, daemon) is a second/third-level page behind a corner ⚙.
Chat is a global view, never embedded per worker. Topology is per task, compact nodes. Buttons must look
like buttons (component library), and third-party libraries are preferred over hand-rolled UI.
Authoritative text: `_kb/tasks/22-superagent-cluster/console-requirements.md` (§3, §14–§16).

**Dispatching console work**: consolidate every piece of feedback into that spec first, then create one
ticket (project `qqbot-ui`, `claude-planner`, from `/api/tickets` so the planner can `hub_write_plan`)
and dispatch it once. Never send patch messages to a running planner. Agents run
typecheck / lint / `bun test packages/cluster-ui` / build only — no browsers, no screenshots; the owner
does visual acceptance.

**Why:** rounds 1–2 were rejected for admin-panel IA, text buttons, oversized tree nodes and hand-written
widgets; mid-run patch messages rewrote one planner's plan four times and burned 150k context.

**How to apply:** before touching `packages/cluster-ui` or writing its ticket, read spec §16 and keep the
two-target top level; put new requirements into the spec, not into messages to workers. See
[[feedback_ticket_series_naming]].

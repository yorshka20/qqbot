# ops/nightly — Nightly Ops Infrastructure

Non-interactive, scheduled maintenance tasks for qqbot, executed by the Claude CLI.

---

## Purpose

`ops/nightly/` provides a zero-human-interaction pipeline that runs one or more
**task prompts** (Markdown files under `tasks/`) through the Claude CLI each
night.  Each task reads repo state (e.g., logs) and writes a Markdown report to
`ops/reports/YYYY-MM-DD/<taskId>.md`.

Currently included task:

| Task | Description |
|------|-------------|
| `log-analysis` | Analyzes yesterday's bot logs; falls back to the last 3 log dirs if yesterday is absent |

---

## Prerequisites

- **Claude CLI** `2.1.76 (Claude Code)` (or later compatible version)
- Bash 4+ (macOS ships Bash 3; install via `brew install bash` or use the system zsh shebang override)
- A MiniMax API key (Anthropic-compatible endpoint)
- Optional: GNU `coreutils` for `timeout` on macOS (`brew install coreutils` provides `gtimeout`)
  — the script has its own fallback timeout implementation so this is not required

---

## Init Steps

1. **Copy the env template and fill in your key:**

   ```bash
   cp ops/nightly/env.sh.example ops/nightly/env.sh
   # Edit env.sh and set ANTHROPIC_API_KEY to your real MiniMax key
   ```

2. **Verify the env file is gitignored** (already configured in `.gitignore`):

   ```bash
   git check-ignore -v ops/nightly/env.sh   # should output the ignore rule
   ```

3. **Ensure the claude CLI is in your PATH:**

   ```bash
   claude --version   # expected: 2.1.76 (Claude Code)
   ```

---

## First Manual Dry Run

```bash
# From repo root
bash ops/nightly/run.sh
```

Reports will appear under `ops/reports/YYYY-MM-DD/`.  Each task produces:

- `<taskId>.md` — the structured report (must contain `## TL;DR`)
- `<taskId>.session.log` — full claude session stdout+stderr

After all tasks finish, a `.completed` marker is created:

```
ops/reports/2026-04-24/
  log-analysis.md          ← report
  log-analysis.session.log ← raw session log
  .completed               ← sentinel: all tasks ran
```

---

## Cron Example

Run nightly at 02:00 local time:

```cron
0 2 * * * /usr/bin/env bash /path/to/qqbot/ops/nightly/run.sh >> /path/to/qqbot/ops/nightly/cron.log 2>&1
```

Or with explicit env sourcing if cron's PATH is stripped:

```cron
0 2 * * * /bin/bash -c 'source /path/to/qqbot/ops/nightly/env.sh && bash /path/to/qqbot/ops/nightly/run.sh' >> /tmp/qqbot-nightly.log 2>&1
```

---

## Directory Contract

```
ops/
  nightly/
    run.sh               ← main entry point (executable)
    settings.json        ← claude deny-list permissions
    env.sh.example       ← template; copy to env.sh (gitignored)
    env.sh               ← GITIGNORED — real secrets go here
    tasks/
      log-analysis.md    ← task prompt (stdin for claude)
      <new-task>.md      ← add more tasks here
    README.md            ← this file

ops/reports/             ← GITIGNORED
  YYYY-MM-DD/
    <taskId>.md          ← report output (must contain ## TL;DR)
    <taskId>.session.log ← raw session log
    .completed           ← marker: all tasks finished for this date
```

Reports directory (`/ops/reports/`) is gitignored — reports stay local.

---

## Adding New Tasks

1. Create `ops/nightly/tasks/<new-task>.md` with a self-contained prompt.
2. The prompt **must** instruct the agent to write its output to `OUTPUT_FILE`
   (injected at runtime via `--append-system-prompt`).
3. The output report **must** contain a `## TL;DR` section.
4. No code changes needed — `run.sh` automatically picks up every `*.md` in `tasks/`.

---

## Non-Interactive Design Rationale

The script enforces four safety layers so no human approval is needed at runtime:

1. **`--permission-mode bypassPermissions`** — the CLI does not pause to ask the
   user for tool approval; all tool calls proceed automatically.
2. **Deny-only `settings.json`** — a strict deny list blocks destructive Bash
   commands (`rm`, `mv`, `git`, `bun`, `curl`, etc.) and all writes to source /
   config / `.git` directories, even though `bypassPermissions` would otherwise
   allow them.  There is intentionally **no** `allow` section.
3. **`CI=true` + `CLAUDE_NON_INTERACTIVE=1`** — suppress interactive prompts
   from the CLI itself.
4. **Hard 30-minute timeout per task** — prevents runaway sessions.  Uses
   `timeout` (Linux) or `gtimeout` (macOS + coreutils) if available.  If
   neither is present, a pure-bash fallback (background process + `sleep` +
   `kill`) is used so macOS machines without coreutils still get a hard timeout.

**Note:** `--dangerously-skip-permissions` is explicitly **NOT** used anywhere.
The permission model relies on `bypassPermissions` (requires user consent once
at setup) combined with the deny list, not on skipping permission checks
entirely.

---

## CLI Flags Used

| Flag | Purpose |
|------|---------|
| `--settings <file>` | Load deny-list permissions from `ops/nightly/settings.json` |
| `--permission-mode bypassPermissions` | Skip per-tool approval prompts at runtime |
| `--allowed-tools <list>` | Restrict available tools to `Read,Grep,Glob,Bash,Write,TodoWrite` |
| `--append-system-prompt <text>` | Inject runtime vars (`REPO_ROOT`, `REPORT_DIR`, `OUTPUT_FILE`, `DATE`) |
| `--print` | Non-interactive: print response and exit |
| `--output-format text` | Plain-text output (no streaming JSON) |

---

## `.completed` Marker

After all tasks finish (regardless of individual task exit codes), `run.sh`
creates `ops/reports/YYYY-MM-DD/.completed`.  This sentinel can be checked by
monitoring scripts:

```bash
test -f ops/reports/$(date +%Y-%m-%d)/.completed && echo "nightly done"
```

If `.completed` is absent past the expected finish time, the nightly run may
have been interrupted.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `env.sh not found` | `cp ops/nightly/env.sh.example ops/nightly/env.sh` and set key |
| `ANTHROPIC_API_KEY is still the placeholder` | Edit `ops/nightly/env.sh`, set real key |
| `claude: command not found` | Set `CLAUDE_CLI=/full/path/to/claude` in `env.sh` |
| Task times out at 30 minutes | Check `<taskId>.session.log`; reduce task scope or increase timeout |
| Report missing `## TL;DR` | Task prompt must instruct the agent to include this heading |
| `gtimeout: command not found` warning | Install coreutils: `brew install coreutils`; or rely on the built-in bash fallback |
| Report dir not created | Check `REPO_ROOT` detection; run `bash -x ops/nightly/run.sh 2>&1 \| head -20` |

---

## CLI Version Record

Tested with:

```
2.1.76 (Claude Code)
```

If you upgrade the CLI, re-verify that the following flags still exist with
the same names before running nightly ops:

- `--settings`
- `--permission-mode bypassPermissions`
- `--allowed-tools`
- `--append-system-prompt`
- `--print`
- `--output-format`

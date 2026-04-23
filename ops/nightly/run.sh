#!/usr/bin/env bash
# ops/nightly/run.sh — Nightly ops runner for qqbot
# Iterates over tasks/*.md and runs each through claude CLI.
# Usage: bash ops/nightly/run.sh

set -uo pipefail

# ---------------------------------------------------------------------------
# Repo root (two levels up from this script)
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ---------------------------------------------------------------------------
# Source env.sh (secrets / overrides)
# ---------------------------------------------------------------------------
ENV_FILE="$REPO_ROOT/ops/nightly/env.sh"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[ERROR] ops/nightly/env.sh not found, copy from env.sh.example and fill in your API key"
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

# ---------------------------------------------------------------------------
# Validate ANTHROPIC_API_KEY
# ---------------------------------------------------------------------------
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "[ERROR] ANTHROPIC_API_KEY is empty. Set it in ops/nightly/env.sh"
  exit 1
fi
if [[ "${ANTHROPIC_API_KEY}" == "REPLACE_WITH_YOUR_MINIMAX_API_KEY" ]]; then
  echo "[ERROR] ANTHROPIC_API_KEY is still the placeholder value. Replace it in ops/nightly/env.sh"
  exit 1
fi

# ---------------------------------------------------------------------------
# Date / report directory
# ---------------------------------------------------------------------------
DATE="$(date +%Y-%m-%d)"
REPORT_DIR="$REPO_ROOT/ops/reports/$DATE"
mkdir -p "$REPORT_DIR"

# ---------------------------------------------------------------------------
# Timeout helper
# Prefer system timeout / gtimeout; fall back to a pure-bash implementation.
# ---------------------------------------------------------------------------
TIMEOUT_CMD="$(command -v timeout || command -v gtimeout || true)"

run_with_timeout() {
  local seconds="$1"
  shift
  if [[ -n "$TIMEOUT_CMD" ]]; then
    "$TIMEOUT_CMD" "$seconds" "$@"
    return $?
  fi
  # Bash fallback timeout: run in background, wait, kill if needed
  "$@" &
  local child_pid=$!
  (
    sleep "$seconds"
    kill "$child_pid" 2>/dev/null || true
  ) &
  local watcher_pid=$!
  wait "$child_pid"
  local rc=$?
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
  return $rc
}

# ---------------------------------------------------------------------------
# Non-interactive environment flags
# ---------------------------------------------------------------------------
export CI=true
export CLAUDE_NON_INTERACTIVE=1

# Claude CLI binary (allow override via CLAUDE_CLI env var)
CLAUDE_CLI="${CLAUDE_CLI:-claude}"

# ---------------------------------------------------------------------------
# Iterate tasks
# ---------------------------------------------------------------------------
for TASK_FILE in "$REPO_ROOT"/ops/nightly/tasks/*.md; do
  [[ -e "$TASK_FILE" ]] || { echo "[WARN] No task files found in ops/nightly/tasks/"; break; }

  TASK="$(basename "$TASK_FILE" .md)"
  OUT="$REPORT_DIR/$TASK.md"
  LOG="$REPORT_DIR/$TASK.session.log"

  if [[ -f "$OUT" ]]; then
    echo "[SKIP] $TASK already has report at $OUT"
    continue
  fi

  echo "[RUN]  $TASK → $OUT"

  APPEND_PROMPT="You are running as a non-interactive nightly ops agent.
Runtime context:
  REPO_ROOT=$REPO_ROOT
  REPORT_DIR=$REPORT_DIR
  OUTPUT_FILE=$OUT
  DATE=$DATE
Write your final report to OUTPUT_FILE ($OUT).
You must include a ## TL;DR section in the report."

  run_with_timeout 1800 \
    "$CLAUDE_CLI" \
      --settings "$REPO_ROOT/ops/nightly/settings.json" \
      --permission-mode bypassPermissions \
      --allowed-tools "Read,Grep,Glob,Bash,Write,TodoWrite" \
      --print \
      --output-format text \
      --append-system-prompt "$APPEND_PROMPT" \
    < "$TASK_FILE" \
    > "$LOG" 2>&1

  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[WARN] task $TASK exited with $rc (see $LOG)"
  else
    echo "[OK]   $TASK completed"
  fi
done

# ---------------------------------------------------------------------------
# Mark run as completed
# ---------------------------------------------------------------------------
touch "$REPORT_DIR/.completed"
echo "[done] $(date) reports at $REPORT_DIR"

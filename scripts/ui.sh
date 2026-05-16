#!/usr/bin/env bash
# WebUI local-client manager. The WebUI is NOT daemonized by PM2; it runs as a
# plain nohup background process so it survives terminal close but is not auto-restarted.
#
#   scripts/ui.sh start     # start in background (idempotent)
#   scripts/ui.sh stop      # stop it (kills the whole process tree)
#   scripts/ui.sh restart
#   scripts/ui.sh status
#
# `bun run --filter @qqbot/webui dev` spawns a tree (bun -> vite -> esbuild),
# so stop walks children before killing the root; killing only the root PID
# would orphan vite/esbuild.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/logs/webui.pid"
LOG_FILE="$ROOT/logs/webui.log"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# Recursively SIGTERM a process and all its descendants (leaves first).
kill_tree() {
  local pid=$1
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

start() {
  if is_running; then
    echo "WebUI already running (pid $(cat "$PID_FILE")). Logs: $LOG_FILE"
    return 0
  fi
  mkdir -p "$ROOT/logs"
  nohup bun run --filter @qqbot/webui dev >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  disown 2>/dev/null || true
  echo "WebUI started (pid $(cat "$PID_FILE")). Logs: $LOG_FILE"
}

stop() {
  if ! is_running; then
    echo "WebUI not running."
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill_tree "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "WebUI stopped."
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status)
    if is_running; then
      echo "WebUI running (pid $(cat "$PID_FILE"))."
    else
      echo "WebUI not running."
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac

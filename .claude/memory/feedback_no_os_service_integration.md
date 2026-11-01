---
name: feedback_no_os_service_integration
description: Don't integrate the bot into OS service managers (launchd / systemd / Windows services); keep process management inside the Bun/Node toolchain
metadata:
  type: feedback
---

Run and supervise the bot with tooling inside the Bun/Node ecosystem (the repo's own `scripts/supervisor/`), started by hand from a terminal. Do not propose installing it into the operating system: no launchd agents/daemons, no systemd units, no Windows services or service wrappers (WinSW/NSSM), no system-level settings changes (e.g. macOS local-network `defaults write` + reboot).

**Why:** The owner rejected it twice (2026-11-02): first for Windows ("改成让用户手动命令启动"), then entirely ("services和系统集成太深了…不要继续系统service这个方向了"). Deep OS integration is per-platform, hard to reason about, and on macOS a launchd agent cannot even reach the LAN (Apple TN3179).

**How to apply:** For auto-start, crash restart or remote control, extend the supervisor or the CLI instead. If a need genuinely can't be met without the OS (start at boot), say so and name it as a concession for the user to set up themselves, rather than building it. Related: [[feedback_local_planning_artifacts]].

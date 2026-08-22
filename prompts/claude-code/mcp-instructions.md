You are running a Claude Code task on behalf of a chat bot. A person asked for
this work in a QQ / WeChat conversation and is waiting for it there — they
cannot see your terminal.

This MCP server is your channel back to them, plus a few bot-side helpers.

## Reporting back

- `bot_notify_task` — the task lifecycle channel. Call it with `status=started`
  once you understand the task, with `status=progress` at real milestones, and
  exactly once at the end with `status=completed` (include `result`) or
  `status=failed` (include `error`). The task ID comes from your connection, so
  you cannot report against the wrong task.
- `bot_send_message` — send a chat message to a user or group. Use it when you
  need to say something mid-task that the requester should see immediately: an
  ambiguity you had to resolve, a destructive change you are about to make, a
  question. Anything you only print to stdout reaches them at best as part of
  the final result.

Prefer `bot_notify_task` for lifecycle and `bot_send_message` for conversation.

## Bot introspection and maintenance

- `bot_info` — connected protocols, uptime, task queue depth.
- `bot_command` — `reload-plugins` / `status` / `restart`. `restart` will kill
  your own process, so only call it as the very last action of a task that
  explicitly asked for it.

## Repository helpers

`git_commit`, `git_branch`, `git_create_pr`, `quality_check`, `project_info`
and `read_file` run inside the bot's project registry, which resolves the
task's project and enforces its allowed base paths. Your own built-in tools
(Read, Bash, Edit) work on the same working directory and are usually more
direct — reach for these when you want the bot's conventions applied, such as
`git_commit`'s project-standard message formatting or `quality_check`'s
configured typecheck/lint/test commands.

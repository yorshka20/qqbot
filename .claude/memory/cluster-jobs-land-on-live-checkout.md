---
name: cluster-jobs-land-on-live-checkout
description: A finished cluster job lands on the project's base branch even when that branch is checked out in the owner's live checkout; the owner chose this over an opt-in
metadata:
  type: project
---

A job ends by fast-forwarding its integration branch onto `baseBranch` (`TaskWorkspaces.landJob`). For `qqbot` and `qqbot-ui` that branch is `master`, held by the live checkout `/Users/yorshka/project/qqbot` where the bot, the daemon and Claude sessions run, so the merge runs there (`--ff-only --no-autostash`) and changes its files.

**Why:** the owner asked for jobs to end on the main branch so finished work can be accepted without a manual merge, and on 2026-11-04 answered "保留" when offered a per-project opt-in instead. Guards stay: overlapping uncommitted changes, a rebase of the branch in progress, or unsettled tasks of the job refuse the landing; the job then shows `landError` and `POST /jobs/:id/land` retries.

**How to apply:** do not add an opt-in or route landing through `bun run deploy`; do not reopen this in reviews. A landing never runs `bun install` or restarts anything: after a job that changes `bun.lock`, the owner deploys.

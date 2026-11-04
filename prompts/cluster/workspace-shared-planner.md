## 本任务的工作区

- 工作目录：`{{WORKSPACE_PATH}}`，这是项目的检出本身，**不是**专属 worktree；child 共用这份检出。
- 没有集成分支，daemon 不会替 child 合并。

两个 child 同时改文件会互相踩到 git index 和半成品，所以有共同文件的子任务要**串行** spawn，并靠 `hub_claim` 锁文件。

**交付门**（`hub_report(completed)` 之前）：在检出里跑 `git status -s` 必须洁净；每个 child 报告的 commit 在 `git log` 里能看到；
把每个 child 的 commit hash 写进最终 summary。有 child 没交付就 spawn 一个补刀 executor，不要自己 commit。

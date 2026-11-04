## 本任务的工作区

- 工作目录：`{{WORKSPACE_PATH}}`，这是项目的检出本身，**不是**专属 worktree；同项目的其他 worker 可能在同一目录里工作。
- 没有集成分支，daemon 不会替你合并。

- 改动提交到检出当前所在的分支；不切分支，不要 `git push`，owner 直接在这份检出里验收。
- 改文件前 `hub_claim`：别的 worker 可能同时在这里工作。

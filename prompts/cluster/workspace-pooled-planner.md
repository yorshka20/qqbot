## 本任务的工作区

- 工作目录：`{{WORKSPACE_PATH}}`（你启动时的 cwd，只属于你的 git worktree）
- 你的分支：`{{TASK_BRANCH}}`，从集成分支当时的最新提交切出
- 本 job 的集成分支：`{{INTEGRATION_BRANCH}}`

每个 executor 跑在自己的 worktree、自己的分支上，互相隔离：不共用 git index，看不到彼此的半成品，不会互相触发 pre-commit。
所以**互相独立的子任务要并行 spawn**，不要因为"同一个仓库"就串行；只有真实的数据依赖才串行，写进 plan 的 `depends_on`。

- child 成功退出后 daemon 立刻把它的分支合入集成分支，owner 在集成分支上验收，不用等整个 job 结束。
- 你 `hub_report(completed)` 并退出后，daemon 把集成分支合入 `{{BASE_BRANCH}}`，**合入成功 job 才算完成**。
  合不进去（冲突，或检出里的改动挡住了）时你这个任务以 `blocked` 结束，原因写在 `error` 里。
  所以 `completed` 的意思是"这些工作可以进 `{{BASE_BRANCH}}`"，不要拿它表示"工作停在集成分支"。
- child 从集成分支当时的最新提交开始。依赖 A 的 B 不用等：现在就 `hub_spawn({ ..., subscribe: { tasks: [A] } })`，
  daemon 让它排队到 A 合入后才启动，它一启动就能看到 A 的改动；A 失败时 B 被取消，`hub_wait` 把你叫醒。
- 并行的 child 改同一个文件时，后合入的那个会以 `blocked` 结束；拆分时让并行的 child 不碰同一批文件。
- `hub_wait` / `hub_query_task` 返回的 `mergedAt` 有值说明已合入；`completed` 却没有 `mergedAt` 说明它没提交任何东西。
- 槽位满时 `hub_spawn` 返回 `queued`，有槽位归还时自动启动，你照常 `hub_wait`。
- 你的 worktree 不装依赖，也**不会**随 child 合入而更新。看 child 的成果用 `git log <集成分支>` /
  `git diff <集成分支>~1 <集成分支>` / `git show <集成分支>:<路径>`，不要切分支。

**交付门**（`hub_report(completed)` 之前）：每个该有改动的 child 都有 `mergedAt`；没有 child 停在 `blocked`；
结果里没有"未提交改动"的警告（daemon 把它写在 child 的 `diffSummary` 末尾，那些改动已随槽位重置丢失）；
`git log --oneline <集成分支>` 里能看到这些 commit，把集成分支名和每个 child 的 commit hash 写进最终 summary。

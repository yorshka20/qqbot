# 第二轮改动

## 改了什么

- **数据层**：`ClusterData` 带上 worker 历史、退出时间、已回答的提问、锁；`lib/` 里的聚合都是带单测的纯函数。
- **总览**：拓扑里每个运行节点都有事实行（开始、时长、用量、模型）；没有 worker 的运行（排队中，或历史里查不到 worker 的已结束运行）也在运行节点上显示 `RunFactsLine`，`RUN_H` 相应调大到 136。
- **运行列表与详情**：对话 / 日志 / 结果三个视图；详情头部有完整描述、模型、用量；运行详情的 tab 随路由 `view` 变化切换。
- **收件箱**：待处理分三类（等你回答、受阻 / 失败、待查看），每件带等了多久；已处理默认展开、按天分组、时间倒序，已回答的显示问、答和回答人；点任一件进对应运行的对话视图；两边都为空时只有一行 `没有需要你的事。`。
- **composer**：运行开始统一走 `submitRun`。解析后的模板（所选，或项目默认）是 planner 且没有 ticket 时先自动新建 ticket 再派发，`retryRun` 同样覆盖；表单提示 `规划器要先有 ticket，提交时会自动新建。`，提交后详情头部显示 `已建 ticket <id>`。ticket 建好但派发失败时报 `已建 ticket <id>，但派发失败：<原因>`。选了 ticket 时有 `编辑正文` 链接，抽屉关闭后文本框更新为保存后的正文。
- **工作器**：在跑卡片显示模板、模型、项目、当前运行、最近一句话、事实行、pid、锁数；去掉了界面上的 job 元信息；新增最近 7 天退出的 worker 段（弱化显示，带结果、退出时间，运行不在已加载窗口时改用 worker 自己的开始 / 结束时间）；模板段显示模型全名，探测结果带模型时优先用它。
- **设置**：模板显示模型全名，id 放 `title`。
- **全局**：`a` 现在由运行详情处理，会先切到对话视图再聚焦回答框；日志面板的悬停底色从被清空的 `white` 色板换成 `log-ink` token。

## 没做到

- 设置页没有 stateDir 和版本：`/health` 只返回 `ok`、`startedAt`、`cluster`。
- "全部"窗口实际只到约一周：`/jobs/:id` 对更早的 job 返回 404，读不到更早的运行。
- 已结束运行的日志只有内存里还在时能看：没有结束后的 stdout 读取路由。
- 长运行的对话可能缺早期事件：`/tasks/:id/events` 上限 100 条。
- 已处理里分不清"已重试"和"已看"：重试只是提交新运行后 acknowledge 旧运行。
- 运行结束后不能真正续跑，只能重新提交或复制续跑命令。
- codex / gemini 的 usage 显示未知：它们的流里没有 usage。
- 空闲槽是各模板余量之和，是上限：`/status` 没有 `maxConcurrentWorkers`。
- 整个界面没有在浏览器里验证过，视觉和交互由 owner 验收。
- 已回答归档在 daemon 重启后会丢：见下面第 12 项。

## 希望 daemon 提供

1. `/health` 增加 `stateDir` 和 `version`。
2. `/jobs/:id`（或另一条路由）对更早的 job 也能返回，让"全部"窗口不止一周。
3. 已结束运行的 stdout 读取路由，结束后也能看日志。
4. `/tasks/:id/events` 支持分页或按 seq 往前翻，不止最近 100 条。
5. 在任务上记录"被重试"（例如 `retriedBy: taskId`），已处理里才能区分已重试和已看。
6. 真正的续跑接口：对已结束的运行用同一 session 追加一条消息。
7. codex / gemini 的流解析出 usage 并写入任务。
8. `/status` 返回 `maxConcurrentWorkers`，空闲槽才是精确值而不是上限。
9. SSE 增加 `task_status` 和 `help_answered`，目前这两类变化要靠刷新才看到。
10. `WorkerProbeResult` 进 `@qqbot/api-types`，现在是 UI 自己声明的形状。
11. `worker_joined` / `worker_left` 事件带 `taskId`，拓扑不必再靠轮询对齐 worker 和运行。
12. 提问历史重启后仍可查：`ContextHub` 把提问写进了 `cluster_help_requests`，但 `loadHelpRequests()` 启动时只把 pending 标成 expired，没有把行读回内存的 `helpRequests` Map，而历史接口读的是这个 Map，所以重启后已回答的归档会丢。启动时把已回答的行读回，或让历史接口直接查表。

## 验收对照

规格 §11 的四条命令（在 worktree 根目录跑）：

- `bun run typecheck`：exit 0。
- `bun run lint`：exit 0（`biome check packages/*/src` 与 `lint:di`；0 error，既有 warning 与本轮无关）。
- `bun test packages/cluster-ui`：190 pass，0 fail，16 个文件。
- `bun run --filter @qqbot/cluster-ui build`：exit 0，只有 chunk 超过 500 kB 的提示。

owner 要特别核对的四件事：

1. **总览里今天已结束的 worker 和它们做了什么**：总览的拓扑和分组列表（已结束的运行 / worker 弱化显示，带事实行和最近一句话）；全部历史在「工作器」页的"最近 7 天退出"。
2. **任意运行的完整描述、可读日志、对话里我的发言和 worker 的回复**：运行详情头部的描述；「日志」视图的"worker 输出"（可读 / 原始切换）；「对话」视图。
3. **收件箱已处理里找回回答过的问题**：收件箱列表底部"已处理"，默认展开，已回答的显示问、答、回答人，点进去是该运行的对话。注意 daemon 重启后会丢（第 12 项）。
4. **每个 worker 都显示模型**：拓扑里的 worker 卡片、工作器页（在跑和已退出两段）、设置页和工作器页的模板列表。

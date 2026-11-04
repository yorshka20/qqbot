# @qqbot/cluster-ui

Agent cluster 的控制台：daemon 把它当静态文件挂在 `/`，一个人在局域网里监工一群常驻 coding agent。

它是**收件箱 + 运行**，不是管理后台。打开先回答"现在有没有需要我的"（收件箱），再回答"大家在干什么"
（总览的任务拓扑、运行列表、一条运行的对话 / 日志 / 结果三视图），最后才是派活和控制。常见用法：手机上看一眼有没有卡住的、回答一个问题；
第二块屏幕盯一条运行的日志；想到一件事，一句话派出去。

界面上没有 job 这个概念，也没有 ticket 页：ticket 是新运行的一个来源，以及结果区的一个链接。

## 怎么跑

daemon 读与 bot 相同的配置树，多一个 `clusterDaemon` 块（`stateDir`、`http`、`auth.token`）。

```bash
bun run packages/agent-cluster/src/daemon/main.ts                  # daemon，默认端口 3200
bun run --filter @qqbot/cluster-ui dev                             # vite，/api 和 /health 代理到 daemon
VITE_DEV_PROXY_TARGET=http://127.0.0.1:3210 bun run --filter @qqbot/cluster-ui dev
CLUSTER_STATE_DIR=<stateDir> bun run build:cluster-ui              # 构建并装进 <stateDir>/ui，daemon 不用重启
bun test packages/cluster-ui
```

第一次打开要输入 `clusterDaemon.auth.token`，存在这台设备的 `localStorage`，401 时退回输入框。

## 代码在哪

| 目录 | 内容 |
|---|---|
| `src/app/` | 外壳（Rail、三栏、底部 tab）、hash 路由、快捷键、主题；`ClusterData.tsx` 是唯一的数据源 |
| `src/inbox/` | 收件箱：提问、失败或受阻、待查看 |
| `src/overview/` | 总览：一行总计 + 项目 → 运行 → worker 的拓扑，手机上退化为分组列表 |
| `src/runs/` | 运行列表、详情（对话、日志、结果三视图，另有会话）、composer、ticket 抽屉 |
| `src/workers/` `src/projects/` `src/settings/` | 其余三页 |
| `src/lib/` | 纯逻辑，都有单测：`stage`（状态映射）、`topology`（分层布局）、`inbox`（待处理与已处理归档）、`runs`（运行聚合、`resolveTemplate`、planner ticket 草稿）、`workers`（worker 历史、结果、运行事实）、`conversation` / `transcript`（对话视图）、`logs`（可读日志）、`usage` / `model`（用量与模型名）、`window`（时间窗）、`timeline`、`resume` |
| `src/api.ts` `src/stream/` `src/auth/` | HTTP、SSE（fetch + ReadableStream，因为 `EventSource` 带不了 Authorization）、token |

全页一条 SSE，事件触发 `ClusterData` 刷新；轮询只在流断开时兜底，切回隐藏的页签时补一次。

路由：`#/inbox[/:id]`、`#/overview`、`#/runs[/:id]`、`#/projects`、`#/workers`、`#/settings`。
查询参数：`pin`（钉住第二条运行）、`new`（打开 composer）、`project` 和 `stage`（筛选运行）、`ticket` 和 `file`（打开 ticket 抽屉）、`view`（运行详情的 `chat` / `log` / `result`）、`created`（composer 为 planner 运行新建的 ticket id，详情头部显示）。

快捷键：`j` `k` 上下、`Enter` 打开、`n` 新运行、`a` 聚焦回答框、`/` 搜索。

## 设计 token

全部在 `src/index.css`：`:root` 是深色，`:root[data-theme="light"]` 是浅色，`@theme inline` 把它们映射给 Tailwind。
`@theme` 里清空了 Tailwind 的默认色板、字号、圆角和阴影，所以 `bg-red-500`、`text-sm`、`rounded-lg` 不生成任何样式：
只有 `bg-surface`、`text-13`、`rounded-ui` 这类 token 可用。圆角只有 `rounded-ui`（6px），没有阴影。

字体是 IBM Plex Sans / Plex Mono 的 latin 子集，打进产物，离线可用。Plex 没有中文字形，中文走系统字体。

字号 scale（`text-*`），逐档用处：

| token | 值 | 用处 |
|---|---|---|
| `text-24` | 24px | 运行详情标题（唯一） |
| `text-18` | 18px | List 与页面标题、收件箱「等了 N 分钟」 |
| `text-16` | 16px | 列表行标题、拓扑运行节点标题、时间线终态标签 |
| `text-15` | 15px | 正文散文（`body` 的基准） |
| `text-14` | 14px | 次要信息：元信息行、按钮、表单 label |
| `text-13` | 13px | 三级信息与等宽：时间戳、pid、sessionId、日志正文 |
| `text-12` | 12px | 状态胶囊文字、时间尺注记 |

终端（日志面板）在浅色模式下仍然是深底：`bg-log-bg` / `text-log-ink`。
`w-list`（23rem）是 List 列宽，`max-w-measure`（44rem）是详情阅读宽度。

四个共享状态 primitive（`src/ui/`），后面的收件箱 / 时间线 / 拓扑都消费它们：

- `StatePill` — 带图标或呼吸点的状态胶囊（淡底 + tone 文字色）
- `StatusBar` — 列表行左侧 3px 的竖条，标出这一行的 tone
- `EmptyState` — 空列表占位：纯 CSS 的三条横线 + 标题 + 可选提示与操作
- `SkeletonRows` — 加载态的静态占位条（无动效）

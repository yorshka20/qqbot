# @qqbot/cluster-ui

Agent cluster 的控制台：daemon 把它当静态文件挂在 `/`，一个人在局域网里监工一群常驻 coding agent。

它是**收件箱 + 对话**，不是管理后台。主对象是 task：一个 task 就是一条对话，planner 派生的子运行挂在它下面。打开先回答"现在有没有需要我的"（收件箱），
再回答"大家在干什么"（侧栏的对话列表；一条对话的对话 / 拓扑 / 结果三个 tab），最后才是派活和控制。常见用法：手机上看一眼有没有卡住的、回答一个问题；
第二块屏幕盯一条对话的日志；想到一件事，一句话派出去。

界面上没有 job 这个概念，也没有 ticket 页：ticket 是新任务的一个来源，以及结果区的一个链接。

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
| `src/app/` | 外壳（侧栏 + 主区，手机上侧栏是抽屉）、快捷键、主题、钉住；`ClusterData.tsx` 是唯一的数据源；`TaskListPanel.tsx` 是对话列表，桌面在侧栏里，手机上就是首页 |
| `src/task/` | 一条对话：对话卡片流（`cards/`）、输入框、详情面板、日志、结果 tab |
| `src/topology/` | 拓扑 tab：任务树（`TopologyTab`，节点两行：标题 / 模型 / 用时 / 已合入 / 续用次数，下一行是最近汇报或 diff 摘要；虚线「依赖」边来自 `dependsOn`），布局由 `lib/taskGraph.ts` 交给 dagre；点子运行或根节点进入这条运行的执行流程图（`RunFlow`：每次运行一个分组，其中按阶段分组、步骤自上而下，右侧是改动文件列），布局是纯函数 `lib/runFlow.ts`，点步骤在侧栏看原始记录 |
| `src/inbox/` | 收件箱：提问、失败或受阻、待查看，以及已处理归档 |
| `src/composer/` | 新任务 composer、ticket 抽屉、`submitRun` |
| `src/settings/` | 设置的六个分组：workers、templates、projects、concurrency、daemon、console |
| `src/components/` | 业务组件；`components/ui/` 是 shadcn 生成的基础组件 |
| `src/lib/` | 纯逻辑，都有单测：`routes`（路由契约）、`taskList`（对话列表分组与钉住）、`taskGraph`（拓扑图）、`home`、`stage`（状态映射）、`inbox`、`runs`（运行聚合、`resolveTemplate`、planner ticket 草稿）、`planning`（规划模式与规划状态）、`conversation` / `transcript`（对话视图）、`runTrace`（把对话折成阶段 / 步骤 / 文件）、`runFlow`（执行流程图布局）、`logs`、`usage` / `model`、`window`、`timeline`、`resume`、`workers`、`daemon`、`slots` |
| `src/api.ts` `src/stream/` `src/auth/` | HTTP、SSE（fetch + ReadableStream，因为 `EventSource` 带不了 Authorization）、token |

全页一条 SSE，事件触发 `ClusterData` 刷新；轮询只在流断开时兜底，切回隐藏的页签时补一次。

路由（`react-router`，浏览器 history，daemon 对未知路径回退到 `index.html`）：

| 路径 | 页面 |
|---|---|
| `/` | 首页（手机上是对话列表） |
| `/inbox` | 收件箱 |
| `/t/:taskId` | 一条对话（根运行） |
| `/t/:taskId/w/:workerId` | 对话下的一条子运行；`:workerId` 是子运行的 task id，不是 worker id |
| `/settings/:group` | 设置分组 |

查询参数：`tab`（`chat` / `topology` / `result`）、`new`（打开 composer）、`ticket` 和 `file`（打开 ticket 抽屉）、`view`（`run`：拓扑 tab 显示这条运行自己的执行流程图，子运行页面默认如此）、`log`（全屏日志）、`created`（composer 为 planner 新建的 ticket id，对话头部显示）。

快捷键：`j` `k` 上下、`Enter` 打开、`n` 新任务、`a` 聚焦回答框、`/` 搜索、`Esc` 返回上一级（浮层打开时只关浮层）。
钉住的对话记在这台设备的 `localStorage`，显示在对话列表顶部。

## 设计 token

全部在 `src/index.css`：`:root` 是深色，`:root[data-theme="light"]` 是浅色，`@theme inline` 把它们映射给 Tailwind。
`@theme` 里清空了 Tailwind 的默认色板，所以 `bg-red-500` 不生成任何样式：颜色只用 `bg-surface`、`text-ink`、`text-failed` 这类 token，
以及 shadcn 的语义名（`bg-background`、`text-muted-foreground`……，它们指向同一批变量，深浅主题只翻一处）。字号和圆角沿用 Tailwind 的名字，值在 `@theme` 里重定义。

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
`max-w-measure`（44rem）是阅读宽度。

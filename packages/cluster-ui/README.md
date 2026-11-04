# @qqbot/cluster-ui

Agent cluster 的控制台：由 daemon serve（`<stateDir>/ui/`，挂在 `/`），部署在局域网。Vite + React 19 + Tailwind v4 + Radix，
只依赖 `@qqbot/api-types` 的类型，不 import `@qqbot/agent-cluster`。

六个 tab：**Overview · Source · Trigger · Eval · Execution · Settings**。Source / Trigger / Eval 等 Phase 2 的 Engine 才有数据源。

## 运行

```bash
# 开发：vite 把 /api 和 /health proxy 到 daemon，默认 http://127.0.0.1:3200
VITE_DEV_PROXY_TARGET=http://127.0.0.1:3210 bun run --filter @qqbot/cluster-ui dev

# 部署：构建并装到 <stateDir>/ui，stateDir 取 $CLUSTER_STATE_DIR，缺省 data/cluster。daemon 不用重启
CLUSTER_STATE_DIR=data/cluster bun run build:cluster-ui
```

## 鉴权与实时流

- 首次打开输入 `cluster.jsonc` 的 `auth.token`，存在这个浏览器的 `localStorage`。任何请求收到 401 都会清掉 token、回到输入框。
- `GET /api/cluster/stream` 要 Bearer，`EventSource` 带不了 header，所以用 `fetch` + `ReadableStream` 解析（`src/stream/`）。
  全页共用一条连接，断线 5 秒重连。

## Panel 原则

三问：① 现在有没有需要我的？② 系统健康、在做对的事吗？③ 一件工作从 Trigger → Eval → Ticket 的历史？

1. 每个元素回答三问之一，否则删。
2. 先列需要人的，再列系统问题，最后才是负载。
3. 分类可判定、互斥、全覆盖。
4. 一个概念一个地方。
5. 数字等于它链接的列表长度。
6. 健康态不占位。
7. 破坏性动作要确认。

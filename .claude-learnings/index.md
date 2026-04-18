# Learnings Index

| Scope | 文件 | 内容摘要 |
|-------|------|---------|
| video-tools | [video-tools.md](video-tools.md) | Gemini 视频 API、VideoDownloadService/ResourceCleanupService、SubAgent 返回 string、extractVideoUrl 裸域名/BV/shorts、light_app 视频 URL 提取（segmentsToText + handler 解析） |
| cluster | [cluster.md](cluster.md) | hub_spawn child 共享 jobId/taskCount=1（只 root 推进计数器）、WorkerRegistry 纯内存重启即丢、/workers 端点 union live + cluster_tasks 历史重建、worker 在 backend.spawn 之前就注册 |
| webui | [webui.md](webui.md) | Tailwind v4 + 少量 Radix primitives、Radix Select 空值禁用/Portal 字色不继承、ticket editor paste-lift frontmatter、Project/Template select 未知值语义、三个 Select 组件复用分布 |
| avatar | [avatar.md](avatar.md) | Preview WS 协议（frame/status 消息结构）、LAN 配置规则（0.0.0.0:8002 + location.hostname）、Bun.serve idleTimeout=255、latestStatus 缓存连接时立即下发；BotState 5 态状态机、转换动画表、idle 随机待机动画（setTimeout 链）、StateNodeOutput 类型独立于 compiler；+ DriverAdapter 抽象（EventEmitter）/ VTSDriver 认证握手 + token 持久化 / 30fps drop-frame 节流 / 指数退避重连；Animation Compiler: ASR 包络 / intensity 单次缩放 / 低通滤波 / 60→30fps 降采样 / EventEmitter 继承 / action-map 格式 |
| monorepo | [monorepo.md](monorepo.md) | bun workspaces 启用与调用方式，packages 目录约定 |

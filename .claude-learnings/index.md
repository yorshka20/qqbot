# Learnings Index

| Scope | 文件 | 内容摘要 |
|-------|------|---------|
| bilibili | [bilibili.md](bilibili.md) | VideoKnowledgeClient DI 注入 + BilibiliService/VideoKnowledgeClient 解耦 + `/b站` 子命令分发；+ **直播弹幕 WS 接入**：16 字节头协议、`-352` 三层根因（裸 getDanmuInfo → WBI 必签、buvid3 必带、`platform='danmuji'` 绕浏览器指纹、SESSDATA+danmuji 冲突必匿名）、`code=1006 Connection ended` 是服务器 RST 不是网络、`reconnectAttempts` 归零必须等 AUTH_REPLY code=0 不能在 onOpen、SESSDATA 从 DevTools 拿是解码形态（自动 URL-encode 归一）、架构链 `LiveClient → DanmakuBuffer → DanmakuStore → LiveBridge → Live2DPipeline` |
| video-tools | [video-tools.md](video-tools.md) | Gemini 视频 API、VideoDownloadService/ResourceCleanupService、SubAgent 返回 string、extractVideoUrl 裸域名/BV/shorts、light_app 视频 URL 提取（segmentsToText + handler 解析） |
| cluster | [cluster.md](cluster.md) | hub_spawn child 共享 jobId/taskCount=1（只 root 推进计数器）、WorkerRegistry 纯内存重启即丢、/workers 端点 union live + cluster_tasks 历史重建、worker 在 backend.spawn 之前就注册；+ batch10: `tickets/<id>/results/job.json` 跨 LAN snapshot（clusterId + workers + tasks），re-dispatch 覆盖语义 + stale task-*.md 清理 + hostname fallback |
| webui | [webui.md](webui.md) | Tailwind v4 + 少量 Radix primitives、Radix Select 空值禁用/Portal 字色不继承、ticket editor paste-lift frontmatter、Project/Template select 未知值语义、三个 Select 组件复用分布 |
| avatar | [avatar.md](avatar.md) | 当前 avatar 速查：`AvatarService` 编排 compiler / VTS / preview / speech，PreviewServer 监听 `0.0.0.0:8002` 且提供 `/action-map`、`/clip/:name`、WS `trigger/speak/ambient-audio/tunable-*`；AnimationCompiler 同时支持 envelope/clip 两条 action 路径，`ActionMap` 预加载 clip，`AudioEnvelopeLayer` 只管 per-utterance lip-sync + excite，`AmbientAudioLayer` 负责 BGM 反应，VRM 通道与 Cubism 通道分离，`tools/vrma-to-clip` 负责离线 VRMA→IdleClip |
| monorepo | [monorepo.md](monorepo.md) | bun workspaces、packages/bot 目录布局与依赖归属、运行时资产 cwd 约定、project references 配置、@/ alias 新映射、PluginManager hardcoded path 修复、allowImportingTsExtensions 移除原因；T3 avatar 抽包要点（hoisting、pre-commit hook 限制、inline import 陷阱、repoRoot 复制 vs logger shim） |

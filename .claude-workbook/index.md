# Workbook Index

| 日期 | 主题 | 关键文件 |
|------|------|---------|
| 2026-04-14 | Video 分析工具链修复：新增 VideoDownloadService/ResourceCleanupService、修正 executor 双重上传、preset timeout/maxToolRounds 配置、测试重写 | src/services/video/, src/tools/executors/AnalyzeVideoToolExecutor.ts, GeminiProvider.ts |
| 2026-04-14 (2) | SubAgent 返回类型链 `unknown` → `string` 全链路修复 + Video 命令 URL 提取增强（裸域名、裸 BV 号、YouTube shorts、混合文本、通用 URL fallback） | src/agent/, src/ai/AIService.ts, VideoAnalyzeCommandHandler.ts, VideoAnalyzePlugin.ts |
| 2026-04-14 (3) | light_app 视频 URL 提取：segmentsToText 附带 jump link URL + VideoAnalyzeCommandHandler 显式解析 light_app segment（仅提取视频 URL） | MilkyMessageSegmentParser.ts, VideoAnalyzeCommandHandler.ts |
| 2026-04-14 (4) | Cluster：markTaskCompleted 加 parentTaskId 守卫修复 hub_spawn 子任务误触发 job-complete + cascade-kill；/workers 端点 union 内存 registry 与从 cluster_tasks 重建的历史 worker，跨重启可见 | ClusterScheduler.ts, ClusterAPIBackend.ts |
| 2026-04-15 | 审计 Modal 与 Recent Jobs 统一用 JobRow；workers 从内联列表改为 `Workers (N)` 按钮 → 新增 JobWorkersModal（按 role 分组 + reportStatus 图标，点 worker 打开 WorkerDetailModal） | webui/src/pages/cluster/components/JobRow.tsx, JobWorkersModal.tsx, HistoryModal.tsx, index.tsx |
| 2026-04-16 | WebUI ticket editor paste-lift frontmatter + Select 组件化（TemplateSelect role 分组、StatusSelect 色点、RegistryProjectSelect Radix 改写）+ Radix Portal 暗色模式字色修复；ClusterPage template select 复用 | webui/src/pages/tickets/frontmatter.ts, webui/src/components/{TemplateSelect,StatusSelect,RegistryProjectSelect}.tsx, TicketEditor.tsx, cluster/index.tsx |
| 2026-04-18 | Avatar Preview Server：本地 + LAN WebSocket 实时预览 Live2D 参数与动画状态，Bun.serve 同一端口提供 HTTP 页面和 WS 广播，0.0.0.0:8002 绑定支持多机访问 | src/avatar/preview/ |

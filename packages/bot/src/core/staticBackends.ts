/**
 * Pulls in every module that mounts HTTP routes, so its `registerStaticBackend` call
 * runs before `StaticServer` builds its route table.
 *
 * This list lives in the composition root on purpose: `services/staticServer` must not
 * import wechat, zhihu, the cluster, memory or persona — the dependency only ever runs
 * module → staticServer, and the root is the one place allowed to know all of them.
 * Ids are the values `lanRelay.*.disabledStaticBackends` may name.
 */

import '@/integrations/agent-cluster/ClusterAPIBackend';
import '@/integrations/agent-cluster/TicketBackend';
import '@/lan/host/LanAPIBackend';
import '@/memory/MemoryStatusBackend';
import '@/persona/PersonaBackend';
import '@/services/codingAgent/CodingAgentAPIBackend';
import '@/services/retrieval/QdrantExplorerBackend';
import '@/services/staticServer/backends/DailyStatsBackend';
import '@/services/staticServer/backends/DocsPreviewBackend';
import '@/services/staticServer/backends/FileManagerBackend';
import '@/services/staticServer/backends/LogsBackend';
import '@/services/staticServer/backends/OutputStaticHost';
import '@/services/wechat/InsightsBackend';
import '@/services/wechat/moments/MomentsBackend';
import '@/services/wechat/ReportBackend';
import '@/services/zhihu/ZhihuBackend';

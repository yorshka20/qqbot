/**
 * Agent Cluster module — barrel export.
 */

export { wireClusterEscalation } from './ClusterEscalation';
export { ClusterManager } from './ClusterManager';
export { ClusterScheduler } from './ClusterScheduler';
export type { ClusterConfig, ClusterProjectConfig, WorkerTemplateConfig } from './config';
export { parseClusterConfig } from './config';
export { ContextHub } from './hub/ContextHub';
export { HubMCPServer } from './hub/HubMCPServer';
export type {
  ClusterStatus,
  JobRecord,
  TaskCandidate,
  TaskRecord,
  WorkerInstance,
} from './types';
export { WorkerPool } from './WorkerPool';

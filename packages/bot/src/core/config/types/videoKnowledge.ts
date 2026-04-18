// Video Knowledge Backend configuration

export interface VideoKnowledgeConfig {
  /** Whether the video knowledge backend integration is enabled */
  enabled: boolean;
  /** Base URL of the video-knowledge-backend (e.g. "http://localhost:8080") */
  baseURL: string;
  /**
   * Local directory where analysis results are stored.
   * Only used when the backend is deployed locally.
   * Path pattern: {dataDir}/kb/{creator_name}/{date}-{sanitized_title}.json
   */
  dataDir?: string;
  /** Polling interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Polling timeout in milliseconds (default: 300000 = 5 minutes) */
  pollTimeoutMs?: number;
}

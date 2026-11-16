// Video Knowledge Backend configuration

export interface VideoKnowledgeConfig {
  /** Whether the video knowledge backend integration is enabled */
  enabled: boolean;
  /** Base URL of the video-knowledge-backend (e.g. "http://localhost:8090") */
  baseURL: string;
  /**
   * Static bearer token issued by POST /api/v1/auth/verify. Used as-is with no refresh, so requests
   * start failing with 401 once it expires (7 days). Ignored when `authPassword` is set.
   */
  authToken?: string;
  /**
   * The backend's access password. When set, the client mints its own tokens via
   * POST /api/v1/auth/verify and renews them before expiry and on 401. Takes precedence over
   * `authToken`. Omit both when the backend runs without auth.
   */
  authPassword?: string;
  /**
   * How long to wait for a submitted analysis to finish, in milliseconds, reconnecting to the task's
   * event stream as needed. Default: 3600000 (1 hour).
   */
  waitTimeoutMs?: number;
}

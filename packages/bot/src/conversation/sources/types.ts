export interface SourceConfig {
  historyAdapter: 'conversation-history' | 'live2d-session';
  responseHandler: 'send-to-im' | 'discard' | 'callback';
  poseLifecycle: boolean;
  promptScene: string; // resolves prompts/scenes/<value>/zh/scene.txt
  /**
   * How concurrent messages from this source are handled, keyed per session (sessionId):
   * - 'concurrent': every message is processed in parallel.
   * - 'drop': while one message for a session is in flight, further messages for the
   *   same session are dropped (not queued) until it responds. Saves tokens by never
   *   running the LLM on messages that arrive mid-processing.
   */
  concurrency: 'concurrent' | 'drop';
}

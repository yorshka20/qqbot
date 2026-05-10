export interface SourceConfig {
  historyAdapter: 'conversation-history' | 'live2d-session';
  responseHandler: 'send-to-im' | 'discard' | 'callback';
  poseLifecycle: boolean;
  promptScene: string; // resolves prompts/scenes/<value>/zh/scene.txt
  serial: boolean;
}

import type { MessageSource } from '../sources';
import type { SourceConfig } from './types';

export const SOURCES: Record<MessageSource, SourceConfig> = {
  'qq-private': {
    historyAdapter: 'conversation-history',
    responseHandler: 'send-to-im',
    poseLifecycle: false,
    promptScene: 'qq-private',
    concurrency: 'drop',
  },
  'qq-group': {
    historyAdapter: 'conversation-history',
    responseHandler: 'send-to-im',
    poseLifecycle: false,
    promptScene: 'qq-group',
    concurrency: 'concurrent',
  },
  discord: {
    historyAdapter: 'conversation-history',
    responseHandler: 'send-to-im',
    poseLifecycle: false,
    promptScene: 'discord',
    concurrency: 'concurrent',
  },
  'avatar-cmd': {
    historyAdapter: 'live2d-session',
    responseHandler: 'callback',
    poseLifecycle: true,
    promptScene: 'avatar-cmd',
    concurrency: 'concurrent',
  },
  'bilibili-danmaku': {
    historyAdapter: 'live2d-session',
    responseHandler: 'discard',
    poseLifecycle: true,
    promptScene: 'bilibili-danmaku',
    // Danmaku share one session per room (bili-room-{roomId}); dropping mid-flight
    // danmaku avoids replying to stale stream chatter that queued behind a slow reply.
    concurrency: 'drop',
  },
  'idle-trigger': {
    historyAdapter: 'live2d-session',
    responseHandler: 'discard',
    poseLifecycle: true,
    promptScene: 'idle-trigger',
    concurrency: 'concurrent',
  },
  bootstrap: {
    historyAdapter: 'conversation-history',
    responseHandler: 'discard',
    poseLifecycle: false,
    promptScene: 'bootstrap',
    concurrency: 'concurrent',
  },
};

export function getSourceConfig(source: MessageSource): SourceConfig {
  const cfg = SOURCES[source];
  if (!cfg) throw new Error(`[sources/registry] unknown source: ${source}`);
  return cfg;
}

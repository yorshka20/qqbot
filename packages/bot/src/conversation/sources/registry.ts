import type { MessageSource } from '../sources';
import type { SourceConfig } from './types';

export const SOURCES: Record<MessageSource, SourceConfig> = {
  'qq-private': {
    historyAdapter: 'conversation-history',
    responseHandler: 'send-to-im',
    poseLifecycle: false,
    promptScene: 'qq-private',
    serial: false,
  },
  'qq-group': {
    historyAdapter: 'conversation-history',
    responseHandler: 'send-to-im',
    poseLifecycle: false,
    promptScene: 'qq-group',
    serial: false,
  },
  discord: {
    historyAdapter: 'conversation-history',
    responseHandler: 'send-to-im',
    poseLifecycle: false,
    promptScene: 'discord',
    serial: false,
  },
  'avatar-cmd': {
    historyAdapter: 'live2d-session',
    responseHandler: 'callback',
    poseLifecycle: true,
    promptScene: 'avatar-cmd',
    serial: false,
  },
  'bilibili-danmaku': {
    historyAdapter: 'live2d-session',
    responseHandler: 'discard',
    poseLifecycle: true,
    promptScene: 'bilibili-danmaku',
    serial: true,
  },
  'idle-trigger': {
    historyAdapter: 'live2d-session',
    responseHandler: 'discard',
    poseLifecycle: true,
    promptScene: 'idle-trigger',
    serial: false,
  },
  bootstrap: {
    historyAdapter: 'conversation-history',
    responseHandler: 'discard',
    poseLifecycle: false,
    promptScene: 'bootstrap',
    serial: false,
  },
};

export function getSourceConfig(source: MessageSource): SourceConfig {
  const cfg = SOURCES[source];
  if (!cfg) throw new Error(`[sources/registry] unknown source: ${source}`);
  return cfg;
}

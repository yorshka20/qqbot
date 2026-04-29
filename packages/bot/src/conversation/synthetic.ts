import { randomUUID } from 'node:crypto';
import type { ProtocolName } from '@/core/config';
import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSource } from './sources';

export interface SyntheticEventInput {
  source: MessageSource;
  userId: string;
  groupId: string | null;
  text: string;
  messageType: 'private' | 'group';
  protocol: ProtocolName;
  timestamp?: number;
}

export function makeSyntheticEvent(input: SyntheticEventInput): NormalizedMessageEvent {
  const id = `synthetic-${input.source}-${randomUUID()}`;
  return {
    id,
    type: 'message',
    timestamp: input.timestamp ?? Date.now(),
    protocol: input.protocol,
    messageType: input.messageType,
    userId: input.userId,
    ...(input.groupId !== null ? { groupId: input.groupId } : {}),
    message: input.text,
    rawMessage: input.text,
    messageId: id,
    segments: [],
    sender: { userId: input.userId, nickname: '__synthetic__' },
  };
}

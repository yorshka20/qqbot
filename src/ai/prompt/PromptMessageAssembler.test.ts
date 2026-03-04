import { describe, expect, it } from 'bun:test';
import type { ConversationMessageEntry } from '@/conversation/history';
import { PromptMessageAssembler } from './PromptMessageAssembler';

describe('PromptMessageAssembler', () => {
  it('builds deterministic output for same input', () => {
    const assembler = new PromptMessageAssembler();
    const entries: ConversationMessageEntry[] = [
      {
        messageId: '1',
        userId: 1001,
        nickname: 'Alice',
        content: 'hello',
        isBotReply: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        messageId: '2',
        userId: 0,
        content: 'hi',
        isBotReply: true,
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ];

    const first = assembler.buildNormalMessages({
      baseSystem: 'base',
      sceneSystem: 'scene',
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'what?' },
    });
    const second = assembler.buildNormalMessages({
      baseSystem: 'base',
      sceneSystem: 'scene',
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'what?' },
    });

    expect(assembler.serializeForFingerprint(first)).toBe(assembler.serializeForFingerprint(second));
  });

  it('serializes image segments into stable tags', () => {
    const assembler = new PromptMessageAssembler();
    const entries: ConversationMessageEntry[] = [
      {
        messageId: '1',
        userId: 1001,
        nickname: 'Alice',
        content: '',
        segments: [{ type: 'image', data: { uri: 'https://example.com/a.png', summary: 'img' } }],
        isBotReply: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];

    const messages = assembler.buildNormalMessages({
      sceneSystem: 'scene',
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'q' },
    });

    expect(messages[1].content).toContain('<image_segment uri="https://example.com/a.png" summary="img" />');
  });
});


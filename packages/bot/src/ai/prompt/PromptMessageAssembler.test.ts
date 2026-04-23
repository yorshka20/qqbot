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

  it('injects fewShotExamples between system messages and history', () => {
    const assembler = new PromptMessageAssembler();
    const entries: ConversationMessageEntry[] = [
      {
        messageId: '1',
        userId: 1001,
        nickname: 'Alice',
        content: 'real user turn',
        isBotReply: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];

    const messages = assembler.buildNormalMessages({
      baseSystem: 'base',
      sceneSystem: 'scene',
      fewShotExamples: [
        { role: 'user', content: 'example input' },
        { role: 'assistant', content: 'example reply' },
      ],
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'q' },
    });

    // [base-system, scene-system, fewshot-user, fewshot-assistant, real-user, final-user]
    expect(messages).toHaveLength(6);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('system');
    expect(messages[2]).toEqual({ role: 'user', content: 'example input' });
    expect(messages[3]).toEqual({ role: 'assistant', content: 'example reply' });
    expect(messages[4].role).toBe('user');
    expect(messages[4].content).toContain('real user turn');
    expect(messages[5].role).toBe('user');
    expect(messages[5].content).toContain('<current_query>');
  });

  it('skips empty fewShotExamples entries', () => {
    const assembler = new PromptMessageAssembler();
    const messages = assembler.buildNormalMessages({
      sceneSystem: 'scene',
      fewShotExamples: [
        { role: 'user', content: '   ' },
        { role: 'assistant', content: 'kept' },
      ],
      historyEntries: [],
      finalUserBlocks: { currentQuery: 'q' },
    });
    // [scene-system, fewshot-assistant(kept), final-user]
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'kept' });
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

    expect(messages[1].content).toContain('<image_segment id="1:0" summary="img" />');
  });
});

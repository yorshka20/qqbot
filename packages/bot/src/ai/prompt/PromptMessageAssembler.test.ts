import { describe, expect, it } from 'bun:test';
import type { ConversationMessageEntry } from '@/conversation/history';
import { foldReasoningIntoContent, PromptMessageAssembler } from './PromptMessageAssembler';


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
  it('renders a summary entry as its own tagged block covering a span, not a chat turn', () => {
    const assembler = new PromptMessageAssembler();
    const from = new Date('2026-08-27T03:30:00.000Z');
    const to = new Date('2026-08-27T04:24:00.000Z');
    const entries: ConversationMessageEntry[] = [
      {
        messageId: 'summary:1',
        userId: 0,
        content: '讨论了 GPU 与 CPU 的差异。',
        isBotReply: false,
        isSummary: true,
        createdAt: from,
        summarySpan: { from, to },
      },
      {
        messageId: '2',
        userId: 1001,
        nickname: 'Alice',
        content: 'hello',
        isBotReply: false,
        createdAt: to,
      },
    ];

    const messages = assembler.buildNormalMessages({
      sceneSystem: 'scene',
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'q' },
    });

    const summaryTurn = messages.find((m) => String(m.content).includes('conversation_summary'));
    expect(summaryTurn?.content).toBe(
      '<conversation_summary 覆盖 8/27 12:30–13:24>\n讨论了 GPU 与 CPU 的差异。\n</conversation_summary>',
    );
    // It is nobody's utterance: no speaker tag, and never attributed to the bot.
    expect(String(summaryTurn?.content)).not.toContain('[speaker:');
    expect(summaryTurn?.role).toBe('user');
  });

  it('carries a bot entry reasoning on the reasoning_content field, never in the text', () => {
    const assembler = new PromptMessageAssembler();
    const entries: ConversationMessageEntry[] = [
      {
        messageId: '1',
        userId: 1001,
        nickname: '测试用户甲',
        content: '在吗',
        isBotReply: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        messageId: '2',
        userId: 0,
        content: '在的',
        isBotReply: true,
        reasoning: '甲是在打招呼，轻松回应即可。',
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ];

    const messages = assembler.buildNormalMessages({
      sceneSystem: 'scene',
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'q' },
    });

    const botTurn = messages.find((m) => m.role === 'assistant');
    // The assistant turn's text demonstrates the output shape, so it holds the reply alone.
    expect(botTurn?.content).toBe('[1/01 09:00] 在的');
    expect(botTurn?.reasoning_content).toBe('甲是在打招呼，轻松回应即可。');
    // A user entry never carries reasoning, whatever its fields hold.
    const userTurn = messages.find((m) => m.role === 'user' && String(m.content).includes('在吗'));
    expect(userTurn?.reasoning_content).toBeUndefined();
  });

  it('timestamps every turn, but tags only the user turn with a speaker', () => {
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
        content: 'hi there',
        isBotReply: true,
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ];

    const messages = assembler.buildNormalMessages({
      sceneSystem: 'scene',
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'q' },
    });

    const userTurn = messages.find((m) => m.role === 'user' && String(m.content).includes('hello'));
    const botTurn = messages.find((m) => m.role === 'assistant');

    expect(userTurn?.content).toBe('[1/01 09:00] [speaker:Alice:1001] hello');
    // The bot's turn is timestamped too — how long ago it spoke decides whether the
    // topic is still live — but a speaker tag here would read as a third participant
    // and, in a 1:1 chat, contradict the private-chat rule that consecutive user
    // messages are the same person.
    expect(botTurn?.content).toBe('[1/01 09:00] hi there');
    expect(String(botTurn?.content)).not.toContain('[speaker:');
  });

  it('maps each history entry to its own message index', () => {
    const assembler = new PromptMessageAssembler();
    const entries: ConversationMessageEntry[] = [
      {
        messageId: '1',
        userId: 1001,
        nickname: '测试用户甲',
        content: '在吗',
        isBotReply: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        messageId: '2',
        userId: 0,
        content: '在的',
        isBotReply: true,
        reasoning: '甲是在打招呼，轻松回应即可。',
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ];

    const { messages, historyMessageIndices } = assembler.buildNormalMessagesWithIndex({
      sceneSystem: 'scene',
      historyEntries: entries,
      finalUserBlocks: { currentQuery: 'q' },
    });

    expect(messages[historyMessageIndices[0]].content).toBe('[1/01 09:00] [speaker:测试用户甲:1001] 在吗');
    expect(messages[historyMessageIndices[1]].content).toBe('[1/01 09:00] 在的');
  });
});

describe('foldReasoningIntoContent', () => {
  it('folds a history assistant turn reasoning ahead of its text and clears the field', () => {
    const folded = foldReasoningIntoContent([
      { role: 'user', content: '[1/01 09:00] [speaker:测试用户甲:1001] 在吗' },
      { role: 'assistant', content: '[1/01 09:00] 在的', reasoning_content: '甲是在打招呼，轻松回应即可。' },
    ]);

    expect(folded[0]).toEqual({ role: 'user', content: '[1/01 09:00] [speaker:测试用户甲:1001] 在吗' });
    expect(folded[1].content).toBe('<thought>\n甲是在打招呼，轻松回应即可。\n</thought>\n[1/01 09:00] 在的');
    expect(folded[1].reasoning_content).toBeUndefined();
  });

  it('leaves a turn without reasoning untouched', () => {
    const msgs = [{ role: 'assistant' as const, content: '在的' }];
    expect(foldReasoningIntoContent(msgs)[0]).toBe(msgs[0]);
  });

  it('keeps a vision turn ContentPart[] intact, prepending the block as its own part', () => {
    const folded = foldReasoningIntoContent([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '[1/01 09:00] 看图说话' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
        ],
        reasoning_content: '这张图是截图。',
      },
    ]);

    expect(folded[0].content).toEqual([
      { type: 'text', text: '<thought>\n这张图是截图。\n</thought>' },
      { type: 'text', text: '[1/01 09:00] 看图说话' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ]);
  });

  it('leaves a tool-call turn alone — its reasoning is replayed by the provider itself', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        content: '',
        reasoning_content: '先查一下。',
        tool_calls: [{ id: 'c1', name: 'noop', arguments: '{}' }],
      },
    ];
    expect(foldReasoningIntoContent(msgs)[0]).toBe(msgs[0]);
  });
});

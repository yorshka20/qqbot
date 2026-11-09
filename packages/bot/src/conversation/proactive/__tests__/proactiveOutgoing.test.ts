import 'reflect-metadata';

import { describe, expect, it } from 'bun:test';
import type { RenderedCard } from '@/context/HookContextHelpers';
import { resolveProactiveOutgoing } from '../proactiveOutgoing';

const SERVED = { provider: 'deepseek', model: 'deepseek-chat' };

const CARD: RenderedCard = {
  segments: [{ type: 'image', data: { uri: 'base64://card' } }],
  textForHistory: '卡片：今日要点',
};

const neverRender = async (): Promise<RenderedCard | null> => {
  throw new Error('a queued card must not be rendered again');
};
const noCard = async (): Promise<RenderedCard | null> => null;

describe('resolveProactiveOutgoing', () => {
  it('sends a queued card even when the model ended the turn with no text', async () => {
    const outgoing = await resolveProactiveOutgoing({ text: '', card: CARD, servedBy: SERVED }, neverRender);
    expect(outgoing).toEqual({ message: CARD.segments, historyText: '卡片：今日要点' });
  });

  it('appends trailing text after a queued card and keeps both in history', async () => {
    const outgoing = await resolveProactiveOutgoing(
      { text: '有问题再问我 [SUBTEXT: 顺手补一句]', card: CARD, servedBy: SERVED },
      neverRender,
    );
    expect(outgoing).toEqual({
      message: [...CARD.segments, { type: 'text', data: { text: '有问题再问我' } }],
      historyText: '卡片：今日要点\n\n有问题再问我',
      subtext: '顺手补一句',
    });
  });

  it('sends plain text as text when it does not render as a card', async () => {
    const outgoing = await resolveProactiveOutgoing({ text: '测试用户甲说得对', card: null, servedBy: SERVED }, noCard);
    expect(outgoing).toEqual({ message: '测试用户甲说得对', historyText: '测试用户甲说得对' });
  });

  it('sends text that renders as a card as that card', async () => {
    const outgoing = await resolveProactiveOutgoing({ text: '# 长文', card: null, servedBy: SERVED }, async () => CARD);
    expect(outgoing).toEqual({ message: CARD.segments, historyText: CARD.textForHistory });
  });

  it('does not render text as a card under /skip_card', async () => {
    const outgoing = await resolveProactiveOutgoing({ text: '# 长文 /skip_card', card: null, servedBy: SERVED }, neverRender);
    expect(outgoing).toEqual({ message: '# 长文', historyText: '# 长文' });
  });

  it('renders the text as a card attributed to the model that wrote it', async () => {
    const seen: unknown[] = [];
    await resolveProactiveOutgoing({ text: '# 长文', card: null, servedBy: SERVED }, async (_text, servedBy) => {
      seen.push(servedBy);
      return CARD;
    });
    expect(seen).toEqual([SERVED]);
  });

  it('sends text as is when no model wrote it', async () => {
    const outgoing = await resolveProactiveOutgoing({ text: '# 长文', card: null, servedBy: null }, neverRender);
    expect(outgoing).toEqual({ message: '# 长文', historyText: '# 长文' });
  });

  it('sends nothing for an empty reply without a card', async () => {
    expect(await resolveProactiveOutgoing({ text: '  ', card: null, servedBy: SERVED }, neverRender)).toBeNull();
  });
});

// Extraction reads a window of up to 500 messages. When that window sits above the
// criteria, the model has to re-walk it in reasoning to apply rules it hadn't read
// yet — one CoT note per message, until the output budget is gone and nothing is
// returned. Rules first, conversation last: the model filters as it reads, and the
// stable half becomes a cacheable prefix.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { getRepoRoot } from '@/utils/repoRoot';

function renderExtract(recentMessagesText: string): string {
  return new PromptManager(join(getRepoRoot(), 'prompts')).render('memory.extract', {
    groupId: '960504183',
    recentMessagesText,
    targetUserSection: '',
    groupCoreScopes: 'topic / rule / event / context',
    groupScopeDescriptions: '',
    userCoreScopes: 'identity / preference / opinion / relationship / behavior / instruction',
    userScopeDescriptions: '',
  });
}

describe('memory.extract prompt', () => {
  it('puts every rule ahead of the conversation window', () => {
    const rendered = renderExtract('[id:0] 8/27 20:26 User<1:someone>: hello');
    const conversationAt = rendered.indexOf('## 近期对话');

    expect(conversationAt).toBeGreaterThan(-1);
    for (const section of ['## 工作方式', '## 核心原则', '## 记忆归属规则', '## 提取标准', '## 输出格式']) {
      expect(rendered.indexOf(section)).toBeGreaterThan(-1);
      expect(rendered.indexOf(section)).toBeLessThan(conversationAt);
    }
  });

  it('keeps the prefix ahead of the window identical across different windows', () => {
    const head = (text: string) => text.slice(0, text.indexOf('## 近期对话'));

    expect(head(renderExtract('[id:0] a'))).toBe(head(renderExtract('[id:0] b\n[id:1] c')));
  });

  it('tells the model not to walk the window message by message', () => {
    expect(renderExtract('[id:0] a')).toContain('不要逐条复述或分析每条消息');
  });
});

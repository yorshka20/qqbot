import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { getRepoRoot } from '@/utils/repoRoot';
import { GROUP_MEMORY_USER_ID } from '../memoryConstants';
import { scopeGuide, slotLabel } from '../memoryScopes';

const promptManager = new PromptManager(join(getRepoRoot(), 'prompts'));

const RENDERS: Record<string, Record<string, string>> = {
  'memory.consolidate': { existingFacts: '#1 [identity] (stable) 甲', newFacts: '- 乙' },
  'memory.review': { facts: '待复审 #1 [behavior] (transient) 甲 ｜ 2026-01-01 ｜ 2026-01-01 ｜ 1 ｜ 0', today: '2026-09-26' },
  'memory.migrate': { legacyMemory: '[identity]\n甲。' },
};

describe('memory prompts', () => {
  for (const [name, vars] of Object.entries(RENDERS)) {
    for (const userId of [GROUP_MEMORY_USER_ID, '10000001']) {
      it(`${name} fills every variable for ${userId === GROUP_MEMORY_USER_ID ? 'group' : 'user'} memory`, () => {
        const rendered = promptManager.render(name, {
          slotLabel: slotLabel(userId),
          scopeGuide: scopeGuide(promptManager, userId),
          manualFacts: '（无）',
          ...vars,
        });
        expect(rendered).not.toMatch(/\{\{\w+\}\}/);
        expect(rendered).toContain(slotLabel(userId));
      });
    }
  }

  it('tells group and user memory apart in the scope guide', () => {
    expect(scopeGuide(promptManager, GROUP_MEMORY_USER_ID)).toContain('群记忆可用：topic / rule / event / context');
    expect(scopeGuide(promptManager, '10000001')).toContain('个人记忆不能有 `rule`');
  });
});

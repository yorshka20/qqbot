// The research subagent's behaviour contract lives in system.txt alone. A task
// template restating any of it would arrive as a later user turn and quietly win
// over the system prompt — which is how commit 1416d061's budget cut was
// neutralised for months by a task.txt nobody updated alongside it.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { getCurrentDateHourForPrompt } from '@/utils/dateTime';
import { getRepoRoot } from '@/utils/repoRoot';

const PROMPTS_DIR = join(getRepoRoot(), 'prompts');

/** The constructor loads prompts/ off disk — same path production takes. */
function loadPrompts(): PromptManager {
  return new PromptManager(PROMPTS_DIR);
}

describe('research subagent prompts', () => {
  it('renders system.txt with the injected date and no leftover variables', () => {
    const system = loadPrompts().render('subagent.research.system', {
      currentDate: getCurrentDateHourForPrompt(),
    });

    expect(system).toContain(getCurrentDateHourForPrompt());
    expect(system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('carries the whole contract: budget, retrieval, accuracy, output shape', () => {
    const system = loadPrompts().render('subagent.research.system', { currentDate: '' });

    for (const section of ['## 调用预算', '## 检索技巧', '## 准确性', '## 输出格式']) {
      expect(system).toContain(section);
    }
  });

  it('has no task template — the user turn is the bare query', () => {
    expect(existsSync(join(PROMPTS_DIR, 'subagent', 'research', 'task.txt'))).toBe(false);
    expect(loadPrompts().getTemplate('subagent.research.task')).toBeNull();
  });
});

// Tests for CharacterBible injection into the reflection system prompt.
//
// Uses a real PromptManager pointed at the project's prompts/ directory
// so we exercise the actual template, not a fake.

import { describe, expect, it } from 'bun:test';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { renderReflectionPrompt } from '../reflection/prompt';

function makePromptManager(): PromptManager {
  return new PromptManager();
}

const BASE_VARS = {
  personaId: 'test-persona',
  phenotypeJson: '{"fatigue":0.2}',
  epigeneticsJson: '{"traits":{}}',
  recentDialogue: 'User<u1>: 你好',
  trigger: 'manual',
};

describe('reflectionPromptBible — CHARACTER BIBLE block', () => {
  it('bible present: rendered output contains markers and bible content', () => {
    const pm = makePromptManager();
    const bibleMd = '## Self-concept\n我是一个独特的虚拟人格UNIQUE_BIBLE_STRING\n## Boundaries\n不假装是真人。';
    const output = renderReflectionPrompt(pm, {
      ...BASE_VARS,
      characterBible: bibleMd,
    });

    expect(output).toContain('========== CHARACTER BIBLE ==========');
    expect(output).toContain('UNIQUE_BIBLE_STRING');
    expect(output).toContain('========== END CHARACTER BIBLE ==========');
  });

  it('bible absent placeholder: rendered output contains markers and placeholder string', () => {
    const pm = makePromptManager();
    const placeholder = '(no character bible configured for this persona)';
    const output = renderReflectionPrompt(pm, {
      ...BASE_VARS,
      characterBible: placeholder,
    });

    expect(output).toContain('========== CHARACTER BIBLE ==========');
    expect(output).toContain(placeholder);
    expect(output).toContain('========== END CHARACTER BIBLE ==========');
  });

  it('constraint #9 sentence is present in rendered output', () => {
    const pm = makePromptManager();
    const output = renderReflectionPrompt(pm, {
      ...BASE_VARS,
      characterBible: 'some bible',
    });

    expect(output).toContain('必须与 character_bible 中的 self_concept 和 boundaries 一致');
  });

  it('other vars still substituted correctly after template change', () => {
    const pm = makePromptManager();
    const output = renderReflectionPrompt(pm, {
      ...BASE_VARS,
      characterBible: 'bible content',
    });

    expect(output).toContain('test-persona');
    expect(output).toContain('{"fatigue":0.2}');
    expect(output).toContain('你好');
    expect(output).toContain('manual');
  });
});

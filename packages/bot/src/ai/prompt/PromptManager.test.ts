import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getRepoRoot } from '@qqbot/shared';
import { PromptManager } from './PromptManager';

describe('PromptManager partials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-partials-'));
  mkdirSync(join(dir, 'parts'));
  writeFileSync(join(dir, 'parts', 'greet.txt'), '你好，{{who}}{{#if loud}}！{{else}}。{{/if}}');
  writeFileSync(join(dir, 'parts', 'outer.txt'), '[{{> parts.greet who="乙"}}]');
  writeFileSync(join(dir, 'page.txt'), '{{title}}\n{{> parts.greet who="甲" loud="true"}}\n{{> parts.outer}}');
  writeFileSync(join(dir, 'leak.txt'), '{{> parts.greet}}');
  writeFileSync(join(dir, 'cycleA.txt'), '{{> cycleB}}');
  writeFileSync(join(dir, 'cycleB.txt'), '{{> cycleA}}');
  writeFileSync(join(dir, 'missing.txt'), '{{> parts.nope}}');
  const pm = new PromptManager(dir);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('inlines partials rendered with their own parameters, nested', () => {
    expect(pm.render('page', { title: '标题' })).toBe('标题\n你好，甲！\n[你好，乙。]');
  });

  test("a partial does not see the includer's variables", () => {
    expect(pm.render('leak', { who: '丙', loud: 'true' })).toBe('你好，{{who}}。');
  });

  test('an include tag arriving through a variable stays literal text', () => {
    expect(pm.render('page', { title: '{{> parts.outer}}' })).toStartWith('{{> parts.outer}}\n');
  });

  test('rejects a cycle and a missing partial', () => {
    expect(() => pm.render('cycleA')).toThrow('Prompt partial cycle: cycleA → cycleB → cycleA');
    expect(() => pm.render('missing')).toThrow('Template "parts.nope" not found');
  });
});

describe('delivery contract fragment', () => {
  const pm = new PromptManager(resolve(getRepoRoot(), 'prompts'));
  const sceneVars = {
    botSelfId: '10000001',
    botNicknameSuffix: '',
    botWakeWordAlias: '',
    botWakeWordTrigger: '',
    botProviderNicknames: '',
  };
  const contract = (params: Record<string, string>) => pm.render('llm.partials.delivery_contract', params);
  const replyPipeline = { toolRoundTextSent: 'true', longTextForwarded: 'true' };

  test('both QQ scenes carry the reply-pipeline contract for their audience', () => {
    expect(pm.render('scenes.qq-group.zh.scene', sceneVars)).toEndWith(
      contract({ audience: '群友', closingActions: 'send_card / speak / react', ...replyPipeline }),
    );
    expect(pm.render('scenes.qq-private.zh.scene', sceneVars)).toEndWith(
      contract({ audience: '用户', closingActions: 'send_card / speak', ...replyPipeline }),
    );
  });

  test('bot-initiated paths carry the variant without tool-round delivery or forwarding', () => {
    const proactive = pm.render('llm.proactive.system', { preferenceText: '', toolInstruct: '', endTurn: 'true' });
    const agenda = pm.render('agenda.agent_loop_system', { toolInstruct: '', endTurn: 'true' });

    expect(proactive).toContain(contract({ audience: '群友', closingActions: 'send_card' }));
    expect(agenda).toEndWith(contract({ audience: '收到消息的人', closingActions: 'send_card' }));
    for (const prompt of [proactive, agenda]) {
      expect(prompt).toContain('调用工具那几轮写的文字不会');
      expect(prompt).not.toContain('合并转发');
    }
    expect(agenda).toContain('不写文字、直接调用 end_turn');
  });

  test('without end_turn on offer, neither bot-initiated prompt mentions it', () => {
    const proactive = pm.render('llm.proactive.system', { preferenceText: '', toolInstruct: '', endTurn: '' });
    const agenda = pm.render('agenda.agent_loop_system', { toolInstruct: '', endTurn: '' });

    for (const prompt of [proactive, agenda]) {
      expect(prompt).not.toContain('end_turn');
      expect(prompt).not.toContain('## 输出投递');
    }
  });
});

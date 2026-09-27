import { describe, expect, test } from 'bun:test';
import { parseAgentCommand } from '../parseAgentCommand';

describe('parseAgentCommand run options', () => {
  test('leading --model / --effort are taken off the prompt', () => {
    const parsed = parseAgentCommand(['--model', 'gpt-6-sol', '-e', 'high', '@qqbot', '修一下', 'bug']);
    expect(parsed).toEqual({
      type: 'task',
      projectIdentifier: 'qqbot',
      prompt: '修一下 bug',
      options: { model: 'gpt-6-sol', effort: 'high' },
    });
  });

  test('the = form is accepted', () => {
    const parsed = parseAgentCommand(['--model=gpt-6-luna', '调研一下']);
    expect(parsed.options).toEqual({ model: 'gpt-6-luna' });
    expect(parsed.prompt).toBe('调研一下');
  });

  test('flags after the prompt starts stay in the prompt', () => {
    const parsed = parseAgentCommand(['解释', '--model', '参数']);
    expect(parsed.options).toEqual({});
    expect(parsed.prompt).toBe('解释 --model 参数');
  });

  test('options apply to new-project', () => {
    const parsed = parseAgentCommand(['-m', 'opus', 'new', '~/p', '--type', 'bun', '建项目']);
    expect(parsed.type).toBe('new-project');
    expect(parsed.options).toEqual({ model: 'opus' });
    expect(parsed.projectType).toBe('bun');
  });

  test('an unknown flag is refused rather than read as prompt', () => {
    expect(parseAgentCommand(['--modle', 'x', 'task'])).toEqual({ type: 'invalid', error: '未知参数 --modle' });
  });

  test('a flag without a value is refused', () => {
    expect(parseAgentCommand(['--effort'])).toEqual({ type: 'invalid', error: '--effort 缺少取值' });
    expect(parseAgentCommand(['-m', '-e', 'high', 'x'])).toEqual({ type: 'invalid', error: '-m 缺少取值' });
  });

  test('a repeated flag is refused', () => {
    expect(parseAgentCommand(['-m', 'a', '--model', 'b', 'x'])).toEqual({ type: 'invalid', error: '--model 重复指定' });
  });

  test('options on a non-task subcommand are refused', () => {
    expect(parseAgentCommand(['-m', 'a', 'status']).type).toBe('invalid');
    expect(parseAgentCommand(['-e', 'low', 'models']).type).toBe('invalid');
  });

  test('models is a subcommand', () => {
    expect(parseAgentCommand(['models'])).toEqual({ type: 'models' });
  });
});

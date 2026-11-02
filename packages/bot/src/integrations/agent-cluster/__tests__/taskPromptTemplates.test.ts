import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentExecutor, CodingAgentTaskManager } from '@qqbot/agent-cluster';
import { PromptManager } from '@/ai/prompt/PromptManager';

describe('coding-agent task prompts rendered from the bot prompt templates', () => {
  test('the prompt comes from the workspace template with the progress protocol filled in', async () => {
    const prompts: string[] = [];
    const executor: AgentExecutor = {
      name: 'codex',
      displayName: 'Shell',
      coAuthorTrailer: '',
      defaultModel: 'sh',
      async listModels() {
        return [];
      },
      async buildInvocation(input) {
        prompts.push(input.prompt);
        return { cmd: ['sh', '-c', 'echo DONE'], env: { ...process.env }, cleanup: async () => {} };
      },
      finalMessage: (stdout) => stdout.trim(),
    };
    const manager = new CodingAgentTaskManager(
      {
        enabled: true,
        port: 0,
        idleTimeout: '30s',
        workspaceRoot: mkdtempSync(join(tmpdir(), 'coding-agent-ws-')),
      },
      { claude: executor, codex: executor, dsh: executor },
      'http://127.0.0.1:0/mcp',
    );
    manager.setPromptTemplates(new PromptManager());

    const task = manager.createTask('对比甲乙两个方案', { type: 'group', id: '10000001' }, undefined, {
      executor: 'codex',
      model: 'sh',
      taskType: 'workspace',
    });
    manager.enqueueTask(task.id);
    await manager.awaitTaskCompletion(task.id);

    const prompt = prompts[0];
    expect(prompt).toContain('和任何项目仓库都无关');
    expect(prompt).toContain('对比甲乙两个方案');
    expect(prompt).toContain(task.workingDirectory ?? '');
    expect(prompt).toContain('bot_notify_task');
    expect(prompt).not.toContain('{{');
  });
});

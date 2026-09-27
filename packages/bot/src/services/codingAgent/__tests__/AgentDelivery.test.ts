import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDelivery, type AgentDeliveryDeps } from '../AgentDelivery';

interface Recorded {
  sent: Array<{ chat: string; target: number; message: unknown }>;
  uploads: Array<{ chat: string; target: number | string; uri: string; name: string }>;
  history: Array<{ targetId: string | number; content: string; viaTool?: string }>;
}

function createDelivery({ connected = true }: { connected?: boolean } = {}) {
  const recorded: Recorded = { sent: [], uploads: [], history: [] };
  const deps = {
    messageAPI: {
      sendGroupMessage: async (target: number, message: unknown) => {
        recorded.sent.push({ chat: 'group', target, message });
        return 11;
      },
      sendPrivateMessage: async (target: number, message: unknown) => {
        recorded.sent.push({ chat: 'user', target, message });
        return 12;
      },
      sendForwardMessage: async () => ({ message_seq: 13 }),
    },
    fileAPI: {
      uploadGroupFile: async (target: number | string, uri: string, name: string) => {
        recorded.uploads.push({ chat: 'group', target, uri, name });
        return 'file-1';
      },
      uploadPrivateFile: async (target: number | string, uri: string, name: string) => {
        recorded.uploads.push({ chat: 'user', target, uri, name });
        return 'file-2';
      },
    },
    historyService: {
      appendBotMessageToSession: async (
        target: { targetId: string | number },
        content: string,
        _protocol: string,
        options?: { viaTool?: string },
      ) => {
        recorded.history.push({ targetId: target.targetId, content, viaTool: options?.viaTool });
      },
    },
    cardRenderer: {
      renderParsedCards: async () => ({
        segments: [{ type: 'image', data: { data: 'x' } }],
        textForHistory: '卡片文本',
      }),
    },
  } as unknown as AgentDeliveryDeps;
  const protocol = connected ? ('milky' as const) : undefined;
  return { delivery: new AgentDelivery(deps, () => ({ protocol, selfId: 10000001 })), recorded };
}

const GROUP = { type: 'group' as const, id: '10000002' };

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-delivery-'));
  writeFileSync(join(root, 'report.zip'), 'zip-bytes');
  return root;
}

describe('AgentDelivery', () => {
  test('text is sent and written to history', async () => {
    const { delivery, recorded } = createDelivery();
    const result = await delivery.sendText(GROUP, '进度：一半');
    expect(result.success).toBe(true);
    expect(recorded.sent).toEqual([{ chat: 'group', target: 10000002, message: '进度：一半' }]);
    expect(recorded.history).toEqual([{ targetId: '10000002', content: '进度：一半', viaTool: 'coding_agent' }]);
  });

  test('a card is rendered, sent, and its text form goes to history', async () => {
    const { delivery, recorded } = createDelivery();
    const result = await delivery.sendCards(GROUP, [{ type: 'paragraph', content: '内容' }], {
      agentName: 'Codex',
      model: 'gpt-6-sol',
    });
    expect(result.success).toBe(true);
    expect(recorded.history[0]).toEqual({ targetId: '10000002', content: '卡片文本', viaTool: 'coding_agent_card' });
  });

  test('a file inside the workspace is uploaded and posted', async () => {
    const root = workspace();
    const { delivery, recorded } = createDelivery();
    const result = await delivery.sendFile(GROUP, join(root, 'report.zip'), { root, maxBytes: 1024 });
    expect(result.success).toBe(true);
    expect(recorded.uploads).toEqual([
      {
        chat: 'group',
        target: 10000002,
        uri: `base64://${Buffer.from('zip-bytes').toString('base64')}`,
        name: 'report.zip',
      },
    ]);
    // The upload itself posts the file; a follow-up file segment is rejected by Milky.
    expect(recorded.sent).toHaveLength(0);
    expect(recorded.history[0].content).toBe('[文件] report.zip (1 KB)');
  });

  test('a path outside the workspace is refused', async () => {
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'agent-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    const { delivery, recorded } = createDelivery();
    const result = await delivery.sendFile(GROUP, join(root, '..', 'agent-outside', 'x'), { root, maxBytes: 1024 });
    expect(result.success).toBe(false);
    const direct = await delivery.sendFile(GROUP, join(outside, 'secret.txt'), { root, maxBytes: 1024 });
    expect(direct.success).toBe(false);
    expect(direct.error).toContain('只能发送工作区');
    expect(recorded.uploads).toHaveLength(0);
  });

  test('a symlink pointing out of the workspace is refused', async () => {
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'agent-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'innocent.txt'));
    const { delivery, recorded } = createDelivery();
    const result = await delivery.sendFile(GROUP, join(root, 'innocent.txt'), { root, maxBytes: 1024 });
    expect(result.success).toBe(false);
    expect(recorded.uploads).toHaveLength(0);
  });

  test('a directory or an oversized file is refused', async () => {
    const root = workspace();
    mkdirSync(join(root, 'out'));
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(2048));
    const { delivery } = createDelivery();
    expect((await delivery.sendFile(GROUP, join(root, 'out'), { root, maxBytes: 1024 })).error).toContain('打包');
    expect((await delivery.sendFile(GROUP, join(root, 'big.bin'), { root, maxBytes: 1024 })).error).toContain('上限');
  });

  test('nothing is sent before the bot is connected', async () => {
    const { delivery, recorded } = createDelivery({ connected: false });
    const result = await delivery.sendText(GROUP, 'x');
    expect(result).toEqual({ success: false, error: 'No protocol available' });
    expect(recorded.sent).toHaveLength(0);
  });
});

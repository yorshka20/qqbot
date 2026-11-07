// ClusterEscalation reconciles the daemon's pending help requests with what the owner has
// already been told: one private message per request, delivered on connect and on each
// announcement, never twice, and again if the send failed.

import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import type { ClusterHelpRequest } from '@qqbot/api-types';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import type { PermissionChecker } from '@/permission';
import type { ClusterClient, ClusterEvent } from '../ClusterClient';
import { ClusterEscalation } from '../ClusterEscalation';

function request(id: string, overrides: Partial<ClusterHelpRequest> = {}): ClusterHelpRequest {
  return {
    id,
    workerId: 'worker-1',
    type: 'escalation',
    question: `问题 ${id}`,
    status: 'pending',
    createdAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

function harness(initialPending: ClusterHelpRequest[]) {
  const pending = [...initialPending];
  const sent: Array<{ userId: string; text: string; protocol: string }> = [];
  let failNextSend = false;
  let failNextMark = false;
  let stream: { onEvent: (e: ClusterEvent) => void; onConnect?: () => void } | null = null;
  const client = {
    getPendingHelpRequests: async () => pending.map((r) => ({ ...r })),
    markHelpRequestNotified: async (askId: string) => {
      if (failNextMark) {
        failNextMark = false;
        throw new Error('mark failed');
      }
      const entry = pending.find((r) => r.id === askId);
      if (entry) {
        entry.notifiedAt = '2026-11-04T00:00:01.000Z';
      }
      return Boolean(entry);
    },
    events: async (onEvent: (e: ClusterEvent) => void, signal: AbortSignal, onConnect?: () => void) => {
      stream = { onEvent, onConnect };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  } as unknown as ClusterClient;
  const messageAPI = {
    sendPrivateMessage: async (userId: string, text: string, protocol: string) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error('send failed');
      }
      sent.push({ userId, text, protocol });
    },
  } as unknown as MessageAPI;
  const permissionChecker = { getOwnerId: () => '10000001' } as unknown as PermissionChecker;
  const config = { getEnabledProtocols: () => [{ name: 'milky' }] } as unknown as Config;
  const create = () => new ClusterEscalation(client, messageAPI, permissionChecker, config);
  return {
    escalation: create(),
    create,
    pending,
    sent,
    failNextSend: () => {
      failNextSend = true;
    },
    failNextMark: () => {
      failNextMark = true;
    },
    connect: async () => {
      stream?.onConnect?.();
      await Bun.sleep(10);
    },
    announce: async (askId: string) => {
      stream?.onEvent({ event: 'help_request', data: { askId } });
      await Bun.sleep(10);
    },
  };
}

describe('ClusterEscalation', () => {
  test('tells the owner about every pending request on connect, once each', async () => {
    const h = harness([request('a1', { options: ['甲', '乙'], context: '背景' }), request('a2')]);
    h.escalation.start();
    await h.connect();
    expect(h.sent.map((m) => m.userId)).toEqual(['10000001', '10000001']);
    expect(h.sent[0].protocol).toBe('milky');
    expect(h.sent[0].text).toContain('askId: a1');
    expect(h.sent[0].text).toContain('上下文: 背景');
    expect(h.sent[0].text).toContain('  2. 乙');
    expect(h.sent[0].text).toContain('/cluster ask answer a1');
    expect(h.sent[1].text).toContain('askId: a2');

    await h.connect();
    await h.announce('a1');
    expect(h.sent).toHaveLength(2);
    h.escalation.stop();
  });

  test('delivers a request announced later, and again one whose send failed', async () => {
    const h = harness([]);
    h.escalation.start();
    await h.connect();
    expect(h.sent).toHaveLength(0);

    h.pending.push(request('b1'));
    h.failNextSend();
    await h.announce('b1');
    expect(h.sent).toHaveLength(0);

    await h.announce('b1');
    expect(h.sent.map((m) => m.text)).toEqual([expect.stringContaining('askId: b1')]);

    // Answered elsewhere, then raised again under the same id: told again.
    h.pending.length = 0;
    await h.connect();
    h.pending.push(request('b1'));
    await h.connect();
    expect(h.sent).toHaveLength(2);
    h.escalation.stop();
  });

  test('does not send a request the daemon already marked notified', async () => {
    const h = harness([request('c1', { notifiedAt: '2026-11-04T00:00:01.000Z' })]);
    h.escalation.start();
    await h.connect();
    expect(h.sent).toHaveLength(0);
    h.escalation.stop();
  });

  test('marks a sent request, but not one whose send failed', async () => {
    const h = harness([request('d1')]);
    h.escalation.start();
    h.failNextSend();
    await h.connect();
    expect(h.pending[0].notifiedAt).toBeUndefined();

    await h.connect();
    expect(h.sent).toHaveLength(1);
    expect(h.pending[0].notifiedAt).toBeString();
    h.escalation.stop();
  });

  test('a failed mark does not cause a second send', async () => {
    const h = harness([request('e1')]);
    h.escalation.start();
    h.failNextMark();
    await h.connect();
    await h.connect();
    expect(h.sent).toHaveLength(1);
    h.escalation.stop();
  });

  test('a restarted bot does not resend what it already sent', async () => {
    const h = harness([request('f1')]);
    h.escalation.start();
    await h.connect();
    expect(h.sent).toHaveLength(1);
    h.escalation.stop();

    const restarted = h.create();
    restarted.start();
    await h.connect();
    expect(h.sent).toHaveLength(1);
    restarted.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ProtocolConfig } from '@/core/config';
import type { WebSocketConnection } from '@/core/connection';
import { APIError, SendDeliveryUnknownError } from '@/utils/errors';
import { MilkyAdapter } from './MilkyAdapter';

const imageSegment = [{ type: 'image' as const, data: { uri: 'http://127.0.0.1/out.png' } }];
const group = { messageType: 'group' as const, groupId: 10000001 };

function adapter(): MilkyAdapter {
  const config = {
    name: 'milky',
    mockSendMessage: false,
    connection: { apiUrl: 'http://milky.test/api' },
  } as unknown as ProtocolConfig;
  return new MilkyAdapter(config, { on: () => {} } as unknown as WebSocketConnection);
}

function answerWith(body: unknown): void {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('MilkyAdapter send outcome', () => {
  let restoreFetch: typeof fetch = globalThis.fetch;

  beforeEach(() => {
    restoreFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = restoreFetch;
  });

  it('leaves a send undecided when LLBot only stopped waiting for QQ', async () => {
    for (const message of [
      "Internal error: invoke timeout, wrapperSession.getMsgService().sendMsg, [ '0', { chatType: 2 } ]",
      'Internal error: waitForSelfEcho timeout',
    ]) {
      answerWith({ status: 'failed', retcode: 500, message });

      const error = await adapter()
        .sendMessage(imageSegment, group, 60000)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SendDeliveryUnknownError);
      expect((error as Error).message).toContain(message);
    }
  });

  it('keeps every other failure a verdict', async () => {
    for (const [retcode, message] of [
      [500, 'Internal error: 当前处于被禁言状态'],
      [-404, 'Group not found'],
      [-500, 'invoke timeout'],
    ] as const) {
      answerWith({ status: 'failed', retcode, message });

      const error = await adapter()
        .sendMessage(imageSegment, group, 60000)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SendDeliveryUnknownError);
      expect((error as Error).message).toContain(message);
    }
  });

  it('reports an abandoned wait on a read as a plain API failure', async () => {
    answerWith({ status: 'failed', retcode: 500, message: 'Internal error: invoke timeout, getGroupMemberList' });

    const error = await adapter()
      .fetchForwardedMessages('forward-id')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(APIError);
    expect(error).not.toBeInstanceOf(SendDeliveryUnknownError);
  });
});

import { describe, expect, it } from 'bun:test';
import { APIContext } from '@/api/types';
import { APIError, SendDeliveryUnknownError } from '@/utils/errors';
import { unansweredCallError } from './ProtocolAdapter';

describe('unansweredCallError', () => {
  it('leaves the outcome of an unanswered send undecided', () => {
    for (const action of ['send_group_msg', 'send_private_msg']) {
      const error = unansweredCallError(new APIContext(action, {}, 'milky', 60000), 'socket closed', 20123);
      expect(error).toBeInstanceOf(SendDeliveryUnknownError);
      expect((error as SendDeliveryUnknownError).elapsedMs).toBe(20123);
      expect(error.message).toContain('socket closed');
      expect(error.message).toContain('elapsed: 20123ms');
    }
  });

  it('treats an unanswered read as a plain API failure', () => {
    const error = unansweredCallError(new APIContext('get_message', {}, 'milky', 15000), 'socket closed', 15001);
    expect(error).toBeInstanceOf(APIError);
    expect(error).not.toBeInstanceOf(SendDeliveryUnknownError);
  });
});

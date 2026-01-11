// Message API method wrappers

import type { APIClient } from '../APIClient';

export interface SendMessageResult {
  message_id: number;
}

export class MessageAPI {
  constructor(private apiClient: APIClient) {}

  async sendPrivateMessage(
    userId: number,
    message: string | unknown[],
    protocol?: string
  ): Promise<number> {
    const result = await this.apiClient.call<SendMessageResult>(
      'send_private_msg',
      {
        user_id: userId,
        message,
      },
      protocol as any
    );
    return result.message_id;
  }

  async sendGroupMessage(
    groupId: number,
    message: string | unknown[],
    protocol?: string
  ): Promise<number> {
    const result = await this.apiClient.call<SendMessageResult>(
      'send_group_msg',
      {
        group_id: groupId,
        message,
      },
      protocol as any
    );
    return result.message_id;
  }
}

// Example echo plugin

import { PluginBase } from '../PluginBase';
import type { NormalizedMessageEvent } from '@/events/types';
import { MessageAPI } from '@/api/methods/MessageAPI';

export class EchoPlugin extends PluginBase {
  readonly name = 'echo';
  readonly version = '1.0.0';
  readonly description = 'Echo plugin that repeats messages';

  private messageAPI?: MessageAPI;

  async onEnable(): Promise<void> {
    this.messageAPI = new MessageAPI(this.api);

    // Listen to private messages
    this.on<NormalizedMessageEvent>('message', async (event) => {
      if (event.type === 'message' && event.messageType === 'private') {
        // Echo the message back
        try {
          await this.messageAPI!.sendPrivateMessage(event.userId, event.message);
        } catch (error) {
          console.error('[EchoPlugin] Failed to send echo message:', error);
        }
      }
    });
  }
}

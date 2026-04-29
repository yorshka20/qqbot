// SessionStrategyPlugin — selects history adapter (conversation-history vs live2d-session)
// per message source by writing a metadata decision tag.

import { getSourceConfig } from '@/conversation/sources/registry';
import type { HookContext } from '@/hooks/types';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

@RegisterPlugin({
  name: 'session-strategy',
  version: '1.0.0',
  description: 'Select history adapter (conversation-history vs live2d-session) per message source',
})
export class SessionStrategyPlugin extends PluginBase {
  @Hook({ stage: 'onMessagePreprocess', priority: 'HIGH', order: 5 })
  async onMessagePreprocess(context: HookContext): Promise<boolean> {
    const cfg = getSourceConfig(context.source);
    context.metadata.set('historyAdapterKind', cfg.historyAdapter);
    return true;
  }
}

import { inject, injectable } from 'tsyringe';
import type { AIManager, CapabilityType } from '@/ai';
import type { ProviderSelector } from '@/ai/ProviderSelector';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

@Command({
  name: 'provider',
  description: 'Switch AI provider',
  usage: '/provider <list|switch> <capability> <provider>',
  permissions: ['admin'],
})
@injectable()
export class AIProviderSwitchCommandHandler implements CommandHandler {
  name = 'provider';
  description = 'Switch AI provider';
  usage = '/provider <list|switch> <capability> <provider>';

  constructor(
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
    @inject(DITokens.PROVIDER_SELECTOR) private providerSelector: ProviderSelector,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const [action, capability, providerName] = args;
    const messageBuilder = new MessageBuilder();
    if (action === 'list') {
      const list = this.aiManager.getAllProviders();
      messageBuilder.text(`Available providers: ${list.map((p) => p.name).join(', ')}`);
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    }
    if (action === 'switch') {
      const provider = this.aiManager.getProvider(providerName);
      if (!provider) {
        return {
          success: false,
          error: 'Provider not found',
        };
      }

      // If in a group context, persist per-group provider selection
      if (context.messageType === 'group' && context.groupId) {
        const sessionId = `group:${context.groupId}`;
        await this.providerSelector.setProviderForSession(sessionId, capability as CapabilityType, provider.name);
        messageBuilder.text(`Switched group provider for ${capability} to: ${provider.name} (persisted)`);
      } else {
        // For private messages, set global default
        this.aiManager.setCurrentProvider(capability as CapabilityType, provider.name);
        messageBuilder.text(`Switched global provider for ${capability} to: ${provider.name}`);
      }

      return {
        success: true,
        segments: messageBuilder.build(),
      };
    }
    return {
      success: false,
      error: 'Invalid action',
    };
  }
}

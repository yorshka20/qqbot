import { AIManager, CapabilityType } from '@/ai';
import { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { inject, injectable } from 'tsyringe';
import { Command } from '../decorators';
import { CommandHandler, CommandResult } from '../types';

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
    @inject(DITokens.CONFIG) private config: Config,
  ) {}

  async execute(args: string[]): Promise<CommandResult> {
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
      this.aiManager.setCurrentProvider(capability as CapabilityType, provider.name);
      messageBuilder.text(`Switched to provider: ${provider.name}`);
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

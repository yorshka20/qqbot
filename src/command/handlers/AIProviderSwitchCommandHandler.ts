import { AIManager, CapabilityType } from '@/ai';
import { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
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
    if (action === 'list') {
      const list = this.aiManager.getAllProviders();
      return {
        success: true,
        message: `Available providers: ${list.map((p) => p.name).join(', ')}`,
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
      return {
        success: true,
        message: `Switched to provider: ${provider.name}`,
      };
    }
    return {
      success: false,
      error: 'Invalid action',
    };
  }
}

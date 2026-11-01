import { inject, injectable } from 'tsyringe';
import type { AIManager, CapabilityType } from '@/ai';
import { ProviderSelector, type SelectableCapability } from '@/ai/ProviderSelector';
import type { Config } from '@/core/config';
import { type DefaultProvidersConfig, describeLLMTarget, type LLMTarget } from '@/core/config/types/ai';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

const USAGE = '/provider <list|switch|reset> <capability> [provider] [model]';

/**
 * In a group, `switch` and `reset` change that group's persisted override; in a private chat
 * they change the global default. Only `llm` takes a model: an LLM is a provider and the model
 * it runs, and a provider switched to without one runs on its own configured model.
 */
@Command({
  name: 'provider',
  description: 'Switch AI provider',
  usage: USAGE,
  permissions: ['admin'],
})
@injectable()
export class AIProviderSwitchCommandHandler implements CommandHandler {
  name = 'provider';
  description = 'Switch AI provider';
  usage = USAGE;

  private readonly configuredDefaults: DefaultProvidersConfig | undefined;

  constructor(
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
    @inject(ProviderSelector) private providerSelector: ProviderSelector,
    @inject(DITokens.CONFIG) config: Config,
  ) {
    this.configuredDefaults = config.getAIConfig()?.defaultProviders;
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const [action, capabilityArg, providerName, model] = args;
    if (action === 'list') {
      const providers = this.aiManager.getAllProviders().map((p) => p.name);
      const defaultLLM = this.aiManager.getDefaultLLM();
      return this.reply(
        `Available providers: ${providers.join(', ')}\nDefault LLM: ${defaultLLM ? describeLLMTarget(defaultLLM) : '(none)'}`,
      );
    }
    if (action !== 'switch' && action !== 'reset') {
      return { success: false, error: 'Invalid action' };
    }
    const capability = this.aiManager
      .getRegisteredCapabilities()
      .find((c): c is CapabilityType & SelectableCapability => c === capabilityArg);
    if (!capability) {
      return { success: false, error: `Unknown capability: ${capabilityArg ?? ''}` };
    }
    const sessionId = context.messageType === 'group' && context.groupId ? `group:${context.groupId}` : null;

    if (action === 'reset') {
      return sessionId ? this.resetGroup(sessionId, capability) : this.resetGlobal(capability);
    }

    const provider = this.aiManager.getProvider(providerName);
    if (!provider) {
      return { success: false, error: 'Provider not found' };
    }
    if (capability !== 'llm') {
      if (model) {
        return { success: false, error: `A model can only be chosen for llm, not ${capability}` };
      }
      if (sessionId) {
        await this.providerSelector.setSessionOverride(sessionId, capability, provider.name);
        return this.reply(`Switched group provider for ${capability} to: ${provider.name} (persisted)`);
      }
      this.aiManager.setDefaultProvider(capability, provider.name);
      return this.reply(`Switched global provider for ${capability} to: ${provider.name}`);
    }

    const target: LLMTarget = model ? { provider: provider.name, model } : { provider: provider.name };
    if (sessionId) {
      await this.providerSelector.setSessionOverride(sessionId, 'llm', target);
      return this.reply(`Switched group LLM to: ${describeLLMTarget(target)} (persisted)`);
    }
    this.aiManager.setDefaultLLM(target);
    return this.reply(`Switched global LLM to: ${describeLLMTarget(target)}`);
  }

  private async resetGroup(sessionId: string, capability: SelectableCapability): Promise<CommandResult> {
    await this.providerSelector.clearSessionOverride(sessionId, capability);
    return this.reply(`Cleared group override for ${capability}; it now follows the global default`);
  }

  /** Put the global default back to what config names. */
  private resetGlobal(capability: SelectableCapability): CommandResult {
    if (capability === 'llm') {
      const target = this.configuredDefaults?.llm;
      if (!target) {
        return { success: false, error: 'No default LLM in config (ai.defaultProviders.llm)' };
      }
      this.aiManager.setDefaultLLM(target);
      return this.reply(`Reset global LLM to: ${describeLLMTarget(target)}`);
    }
    const providerName = this.configuredDefaults?.[capability];
    if (!providerName) {
      return { success: false, error: `No default ${capability} provider in config (ai.defaultProviders)` };
    }
    this.aiManager.setDefaultProvider(capability, providerName);
    return this.reply(`Reset global provider for ${capability} to: ${providerName}`);
  }

  private reply(text: string): CommandResult {
    return { success: true, segments: new MessageBuilder().text(text).build() };
  }
}

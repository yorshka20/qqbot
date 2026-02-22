// Gacha Plugin - one-click NAI prompt generation with DeepSeek then proxy to /nai command

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { CommandBuilder } from '@/command/CommandBuilder';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import { createHookContextForCommand } from '@/command/utils/HookContextBuilder';
import { getSessionId } from '@/config/SessionUtils';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import { Plugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { PluginCommandHandler } from '@/plugins/PluginCommandHandler';
import { logger } from '@/utils/logger';
import { parseStandardPrompt, slotsToNaiPrompt } from './parse';

const GACHA_USAGE = '/gacha [theme]';

/**
 * Gacha Plugin
 * Registers /gacha command: generate NAI-format prompt with DeepSeek, then proxy to /nai to generate image.
 */
@Plugin({
  name: 'gacha',
  version: '1.0.0',
  description: 'One-click gacha: generate NAI prompt with DeepSeek then run NAI',
})
export class GachaPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private llmService!: LLMService;
  private hookManager!: HookManager;
  private promptManager!: PromptManager;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    this.hookManager = container.resolve<HookManager>(DITokens.HOOK_MANAGER);
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);

    if (!this.commandManager) {
      throw new Error('[GachaPlugin] CommandManager not found');
    }
    if (!this.llmService) {
      throw new Error('[GachaPlugin] LLMService not found');
    }
    if (!this.hookManager) {
      throw new Error('[GachaPlugin] HookManager not found');
    }
    if (!this.promptManager) {
      throw new Error('[GachaPlugin] PromptManager not found');
    }
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    logger.info('[GachaPlugin] Enabling gacha plugin');

    const handler = new PluginCommandHandler(
      'gacha',
      'One-click gacha: generate NAI prompt with DeepSeek then run NAI',
      GACHA_USAGE,
      async (args: string[], context: CommandContext) => {
        return this.executeGacha(args, context);
      },
      this.context,
    );

    this.commandManager.register(handler, this.name);
    logger.info('[GachaPlugin] Registered /gacha command');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    logger.info('[GachaPlugin] Disabling gacha plugin');
    this.commandManager.unregister('gacha', this.name);
    logger.info('[GachaPlugin] Unregistered /gacha command');
  }

  private async executeGacha(args: string[], context: CommandContext): Promise<CommandResult> {
    const theme = args.join(' ').trim();
    const randomSeed = Math.floor(Math.random() * 1e9);
    const requestLine = theme
      ? `Theme: ${theme} [Seed: ${randomSeed}]`
      : `Random creative anime illustration [Seed: ${randomSeed}]`;
    const userMessage = this.promptManager.render('gacha.nai_user', {
      requestLine,
      style: 'CONCISE (15-20 tags MAX)',
    }, { injectBase: false });

    const systemPrompt = this.promptManager.render('gacha.nai_system', {}, { injectBase: false });
    const sessionId = getSessionId(context);

    let rawResponse: string;
    try {
      const response = await this.llmService.generate(userMessage, {
        systemPrompt,
        temperature: 0.8,
        maxTokens: 8192,
        sessionId,
      }, 'deepseek');
      rawResponse = (response?.text ?? '').trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error('[GachaPlugin] LLM generation failed:', msg);
      return {
        success: false,
        error: `Prompt generation failed: ${msg}`,
      };
    }

    if (!rawResponse) {
      return {
        success: false,
        error: 'LLM returned empty response',
      };
    }

    const slots = parseStandardPrompt(rawResponse);
    const totalTags = Object.values(slots).reduce((acc, arr) => acc + arr.length, 0);
    if (totalTags === 0) {
      logger.warn('[GachaPlugin] No valid prompt block or tags parsed from LLM response');
      return {
        success: false,
        error: 'AI returned invalid prompt format (no <提示词> or tags). Please try again.',
      };
    }

    const naiPrompt = slotsToNaiPrompt(slots);
    if (!naiPrompt.trim()) {
      return {
        success: false,
        error: 'Parsed prompt was empty. Please try again.',
      };
    }

    const parsedCommand = CommandBuilder.build('nai', [naiPrompt]);
    const hookContext = createHookContextForCommand(context, naiPrompt);

    try {
      const result = await this.commandManager.execute(
        parsedCommand,
        context,
        this.hookManager,
        hookContext,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error('[GachaPlugin] NAI command execution failed:', msg);
      return {
        success: false,
        error: `Image generation failed: ${msg}`,
      };
    }
  }
}

// FanoutServices — everything the fan-out base needs, injected once as one dependency.
//
// A concrete fan-out takes this plus only what its own context needs, instead of
// re-declaring the base's whole dependency list in every subclass constructor.

import { inject, singleton } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { LLMService } from '@/ai/services/LLMService';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { HookManager } from '@/hooks/HookManager';
import type { ToolManager } from '@/tools/ToolManager';

@singleton()
export class FanoutServices {
  /** Tools run as this account, whoever triggered the run. */
  readonly botSelfId: string;

  constructor(
    @inject(LLMService) readonly llmService: LLMService,
    @inject(DITokens.TOOL_MANAGER) readonly toolManager: ToolManager,
    @inject(HookManager) readonly hookManager: HookManager,
    @inject(DITokens.PROMPT_MANAGER) readonly promptManager: PromptManager,
    @inject(DITokens.CONFIG) readonly config: Config,
  ) {
    this.botSelfId = config.getConfig().bot.selfId;
  }
}

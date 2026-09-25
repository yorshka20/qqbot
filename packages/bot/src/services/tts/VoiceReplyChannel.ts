// VoiceReplyChannel — the LLM's voice output: the `speak` tool plus the prompt fragment that
// tells the model when to use it.
//
// Registered at startup rather than through the @Tool registry: the tool's voice enum and cue
// vocabulary are facts about the configured TTS provider. registerSpeakTool returns the
// tool's live availability gate and the prompt fragment shares it, so neither can outlive
// the backend's health.

import { inject, singleton } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { createVoiceReplyProducer } from '@/ai/prompt/producers/VoiceReplyProducer';
import { PromptInjectionRegistry } from '@/conversation/promptInjection/PromptInjectionRegistry';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { registerSpeakTool } from '@/tools/executors/SpeakToolExecutor';
import type { ToolManager } from '@/tools/ToolManager';
import type { TTSManager } from './TTSManager';
import { resolveVoiceReplyConfig } from './voiceReplyConfig';

@singleton()
export class VoiceReplyChannel {
  constructor(
    @inject(DITokens.CONFIG) private readonly config: Config,
    @inject(DITokens.TTS_MANAGER) private readonly ttsManager: TTSManager,
    @inject(DITokens.TOOL_MANAGER) private readonly toolManager: ToolManager,
    @inject(DITokens.PROMPT_MANAGER) private readonly promptManager: PromptManager,
    @inject(PromptInjectionRegistry) private readonly promptInjectionRegistry: PromptInjectionRegistry,
  ) {}

  install(): void {
    const limits = resolveVoiceReplyConfig(this.config.getTTSConfig()?.voiceReply);
    const isAvailable = registerSpeakTool({ toolManager: this.toolManager, ttsManager: this.ttsManager, limits });
    if (isAvailable) {
      this.promptInjectionRegistry.register(
        createVoiceReplyProducer({ promptManager: this.promptManager, limits, isAvailable }),
      );
    }
  }
}

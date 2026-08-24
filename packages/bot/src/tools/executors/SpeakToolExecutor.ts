// The `speak` tool — the reply LLM's own voice channel: it authors a short
// speech script (plain text plus inline delivery cues), and the synthesized
// audio goes straight to the current chat as a voice message.
//
// Registered by `registerSpeakTool` at bootstrap instead of through the @Tool
// decorator, because the schema itself is built from runtime facts: the voice
// enum comes from the configured voiceMap and the cue vocabulary comes from
// the backing provider. The tool requires a backend that interprets inline
// cues (Fish Audio S2) — LLM-directed delivery is the whole feature, and a
// cue-less backend would just read the words. Config decides whether it is
// registered; the provider's live health decides whether it is offered, via
// the `available` gate.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { stripCues } from '@/services/tts/speechCues';
import type { TTSManager } from '@/services/tts/TTSManager';
import type { TTSCapabilities } from '@/services/tts/TTSProvider';
import type { ResolvedVoiceReplyConfig } from '@/services/tts/voiceReplyConfig';
import { logger } from '@/utils/logger';
import type { ToolManager } from '../ToolManager';
import type { ToolCall, ToolExecutionContext, ToolResult, ToolSpec } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/**
 * Speed bounds for chat voice. The backend accepts a wider range (Fish Audio:
 * 0.5–2.0), but past these edges a QQ voice message stops reading as someone
 * talking and starts reading as a broken recording.
 */
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.4;

const SEND_TIMEOUT_MS = 30_000;

export class SpeakToolExecutor extends BaseToolExecutor {
  name = 'speak';

  /**
   * `providerName` is the provider whose voiceMap and cue vocabulary the tool
   * schema was built from — pinning it here keeps the advertised voices and the
   * synthesized audio from drifting apart if the manager default changes later.
   */
  constructor(
    private readonly ttsManager: TTSManager,
    private readonly limits: ResolvedVoiceReplyConfig,
    private readonly providerName: string,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const script = typeof call.parameters?.text === 'string' ? call.parameters.text.trim() : '';
    const spoken = stripCues(script);
    if (!spoken) {
      return this.error('语音内容不能为空（去掉标记后没有可朗读的文字）', 'empty speech script');
    }
    if (spoken.length > this.limits.maxTextLength) {
      return this.error(
        `这段话太长了（${spoken.length} 字，语音上限 ${this.limits.maxTextLength} 字）。语音适合一两句话，更长的内容请直接输出文本回复。`,
        'speech script too long',
      );
    }

    const hookContext = context.hookContext;
    if (!hookContext?.message) {
      return this.error('缺少会话上下文，无法发送语音', 'missing hook context');
    }

    const alreadySent = hookContext.metadata.get('voiceReplyCount') ?? 0;
    if (alreadySent >= this.limits.maxPerReply) {
      return this.error(
        `本次回复的语音条数已达上限（${this.limits.maxPerReply} 条），剩下的内容请直接输出文本回复。`,
        'voice reply limit reached',
      );
    }

    const voice = typeof call.parameters?.voice === 'string' ? call.parameters.voice.trim() || undefined : undefined;
    const speed = this.resolveSpeed(call.parameters?.speed);

    let outcome: Awaited<ReturnType<TTSManager['synthesize']>>;
    try {
      outcome = await this.ttsManager.synthesize(script, {
        provider: this.providerName,
        requireInlineCues: true,
        ...(voice ? { voice } : {}),
        ...(speed !== undefined ? { prosody: { speed } } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[SpeakToolExecutor] synthesis failed:', err);
      return this.error(`语音合成失败：${msg}。请直接输出文本回复。`, msg);
    }

    const audio = Buffer.from(outcome.result.bytes);
    const segments = new MessageBuilder().record({ data: audio.toString('base64') }).build();

    const messageAPI = getContainer().resolve<MessageAPI>(DITokens.MESSAGE_API);
    let messageSeq: number | undefined;
    try {
      // Target comes from the conversation context, never from LLM parameters —
      // this tool must not be able to speak into arbitrary chats.
      const sendResult = await messageAPI.sendFromContext(segments, hookContext.message, SEND_TIMEOUT_MS);
      messageSeq = sendResult.message_seq;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[SpeakToolExecutor] voice send failed:', err);
      return this.error(`语音发送失败：${msg}。请直接输出文本回复。`, msg);
    }

    hookContext.metadata.set('voiceReplyCount', alreadySent + 1);
    await this.persistSentVoice(hookContext, spoken, voice, messageSeq);

    logger.info(
      `[SpeakToolExecutor] voice sent | provider=${outcome.provider.name} voice=${voice ?? '(default)'} speed=${speed ?? '(default)'} chars=${spoken.length}`,
    );

    return this.success(
      `语音已发送（本次回复第 ${alreadySent + 1}/${this.limits.maxPerReply} 条）。用户听到的就是这段话，不要在最终文本里重复它；没有别的要说就调用 end_turn。`,
      { provider: outcome.provider.name, voice: voice ?? null, spokenChars: spoken.length },
    );
  }

  /** Out-of-range speeds are clamped rather than rejected — the intent ("faster") still lands. */
  private resolveSpeed(raw: unknown): number | undefined {
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
  }

  /**
   * Persist the delivered voice message as readable text. The send bypasses
   * SendSystem/onMessageSent, and history must hold what the bot actually
   * said — otherwise the next turn's LLM sees a gap where its own voice reply
   * was. Cues are delivery directives, not content, so they are stripped.
   */
  private async persistSentVoice(
    hookContext: HookContext,
    spoken: string,
    voice: string | undefined,
    messageSeq?: number,
  ): Promise<void> {
    const message = hookContext.message;
    const isGroup = message.messageType === 'group';
    const targetId = isGroup ? message.groupId : message.userId;
    if (targetId == null) return;
    const historyService = getContainer().resolve<ConversationHistoryService>(DITokens.CONVERSATION_HISTORY_SERVICE);
    const botSelfId = Number(hookContext.metadata.get('botSelfId'));
    await historyService.appendBotMessageToSession(
      { sessionType: isGroup ? 'group' : 'user', targetId },
      `[语音${voice ? `·${voice}` : ''}] ${spoken}`,
      message.protocol,
      {
        botUserId: Number.isNaN(botSelfId) ? 0 : botSelfId,
        messageSeq,
        viaTool: 'speak',
      },
    );
  }
}

/**
 * Register the tool + executor, and return the live availability predicate so
 * the caller can gate the matching prompt fragment on the same signal (or null
 * when the capability isn't configured at all, and nothing should be said about
 * voice replies anywhere).
 *
 * The provider is resolved once here because its voiceMap and cue vocabulary
 * shape the schema; its *health* is not read here — that's what the returned
 * predicate is for.
 */
export function registerSpeakTool(deps: {
  toolManager: ToolManager;
  ttsManager: TTSManager;
  limits: ResolvedVoiceReplyConfig;
}): (() => boolean) | null {
  const { toolManager, ttsManager, limits } = deps;

  if (!limits.enabled) {
    logger.info('[registerSpeakTool] tts.voiceReply.enabled=false — `speak` tool not registered');
    return null;
  }

  const targetName = limits.provider ?? ttsManager.getDefaultName();
  const provider = targetName ? ttsManager.get(targetName) : null;
  if (!provider?.isAvailable()) {
    logger.info(
      `[registerSpeakTool] no configured TTS provider (target="${targetName ?? '(none)'}") — \`speak\` tool not registered`,
    );
    return null;
  }
  if (provider.capabilities.inlineCues === 'none') {
    logger.info(
      `[registerSpeakTool] provider "${provider.name}" has no inline-cue support — \`speak\` tool not registered (needs a Fish Audio S2 model)`,
    );
    return null;
  }

  const providerName = provider.name;
  const isAvailable = () => ttsManager.isProviderUsable(providerName);
  const voices = provider.listVoices?.() ?? [];
  toolManager.registerTool(
    buildSpeakSpec({ limits, voices, capabilities: provider.capabilities, available: isAvailable }),
  );
  toolManager.registerExecutor(new SpeakToolExecutor(ttsManager, limits, providerName));
  logger.info(
    `[registerSpeakTool] \`speak\` registered | provider=${providerName} cues=${provider.capabilities.inlineCues} voices=${voices.length} maxPerReply=${limits.maxPerReply} maxChars=${limits.maxTextLength}`,
  );
  return isAvailable;
}

function cueGuide(capabilities: TTSCapabilities): string {
  const vocabulary = capabilities.cueVocabulary.map((cue) => `[${cue}]`).join(' ');
  return [
    `可以在文本里内嵌方括号标记来控制情绪、语气和音效，标记本身不会被读出来：${vocabulary}。`,
    '标记写英文，也可以自由描述（如 [whispering, amused]、[very excited]、[slightly sad]）；',
    '一句话最多叠 3 个，放在它要生效的那句话开头（[emphasis] 放在要强调的词前面），多句话可以逐句换情绪。',
  ].join('');
}

function buildSpeakSpec(args: {
  limits: ResolvedVoiceReplyConfig;
  voices: string[];
  capabilities: TTSCapabilities;
  available: () => boolean;
}): ToolSpec {
  const { limits, voices, capabilities, available } = args;
  return {
    name: 'speak',
    available,
    description:
      `用你自己的声音说一句话，合成语音后直接以语音消息发到当前会话（不是文字）。${cueGuide(capabilities)} ` +
      `语气本身就是内容的时候，语音比文字有意思得多。单条上限 ${limits.maxTextLength} 字，一次回复最多 ${limits.maxPerReply} 条。`,
    executor: 'speak',
    // QQ only: the Discord adapter has no voice-message segment and would
    // render the audio as a literal `[audio: base64://…]` text blob.
    visibility: { reply: { sources: ['qq-private', 'qq-group'] } },
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: `要说出来的话，含情绪标记。控制在 ${limits.maxTextLength} 字以内（标记不计入字数）。`,
      },
      ...(voices.length > 0
        ? {
            voice: {
              type: 'string' as const,
              required: false,
              enum: voices,
              description: '音色。省略则用你平时的声音；想模仿、整活、演一段时才换成别的音色。',
            },
          }
        : {}),
      speed: {
        type: 'number',
        required: false,
        description: '语速倍率，1 为正常。急着说话可以 1.2，懒洋洋可以 0.85。超出范围会被收敛到可听的区间。',
      },
    },
    examples: [
      '[laughing] 哈哈哈哈你这也太离谱了吧',
      '[whispering] 我跟你说个秘密…… [break] 其实我也不知道',
      '[excited] 中了中了！我们赢啦！',
      '[sighing] 唉，又要加班了',
    ],
    triggerKeywords: ['语音', '说话', '念', '唱', '用声音', '发个语音', '说给我听'],
    whenToUse:
      '一句话的语气比字面内容更重要时优先用它：打招呼、吐槽、附和、逗趣、撒娇、模仿某个人说话、念梗、演一段。' +
      '也可以在用户明确要求"发语音/说给我听"时用。适合一两句话——用户点开就听完。' +
      '不要用语音念长解释、列表、代码、链接、数字资料，或任何用户可能要回看的信息，那些必须走文本。' +
      '语音发出后不要再用最终文本重复同一句话；没有别的要说就调用 end_turn。',
  };
}

import { injectable } from 'tsyringe';
import { LocalAudioService, MAX_SPEAK_CHARS } from '@/services/audio/LocalAudioService';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolModelDescription, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

const audioService = new LocalAudioService();

export function describeLocalAudioForModel(): ToolModelDescription {
  const sounds = audioService.listSounds();
  if (sounds.length === 0) {
    return {
      parameterOverrides: {
        sound: { type: 'string', required: false, description: '提示音名字。当前机器上没有可用提示音。' },
      },
    };
  }
  return {
    parameterOverrides: {
      sound: {
        type: 'string',
        required: false,
        enum: sounds,
        description: `提示音名字，在说话前先响一声用来引起注意。可选：${sounds.join(' / ')}。`,
      },
    },
  };
}

@Tool({
  name: 'local_audio',
  description: `让 bot 所在的那台机器出声：播一个提示音、念一段话，或者先响提示音再念。声音从机器的扬声器出来，不是发到聊天里的语音消息。

- 用于定时提醒、语音通告这类需要把人从屏幕外叫回来的场合。
- 只有机器旁边的人听得到，聊天里的其他人收不到任何东西；要发语音消息请用 speak。
- text 和 sound 至少给一个，两个都给就先响提示音再念 text。
- 念完才返回，所以文本控制在 ${MAX_SPEAK_CHARS} 字以内。`,
  executor: 'local_audio',
  // `say` only returns when the utterance ends; the service kills it at 45s.
  timeoutMs: 60_000,
  // adminOnly: this is a physical side effect on the owner's machine, unlike every
  // other tool whose blast radius ends at the chat. Agenda tasks still reach it —
  // AgentLoop takes the reply scope, which carries no admin gate.
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true } },
  available: () => LocalAudioService.isSupported(),
  describeForModel: describeLocalAudioForModel,
  parameters: {
    text: {
      type: 'string',
      required: false,
      description: `要念出来的话，${MAX_SPEAK_CHARS} 字以内。`,
    },
    sound: {
      type: 'string',
      required: false,
      description: '提示音名字。',
    },
  },
  examples: ['提醒我十分钟后该起来活动了', '到点了喊我一声', '出声提醒我会议要开始了'],
  whenToUse:
    '用户要求「出声提醒我」「到点喊我」，或定时任务到点需要把人叫到电脑前时调用。只发文字就能说清楚的事不要用这个，它会打扰到机器旁边的人。',
})
@injectable()
export class LocalAudioToolExecutor extends BaseToolExecutor {
  name = 'local_audio';

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const text = typeof call.parameters?.text === 'string' ? call.parameters.text.trim() : '';
    const sound = typeof call.parameters?.sound === 'string' ? call.parameters.sound.trim() : '';

    if (!text && !sound) {
      return this.error('请给出要念的文本或提示音名字', 'Missing both parameters: text / sound');
    }
    if (!LocalAudioService.isSupported()) {
      return this.error('这台机器不支持本地发声', `unsupported platform: ${process.platform}`);
    }

    const played: string[] = [];

    if (sound) {
      const result = await audioService.playSound(sound);
      if (!result.success) {
        return this.error(result.error ?? '提示音播放失败', result.error ?? 'afplay failed');
      }
      played.push(`提示音 ${sound}`);
    }

    if (text) {
      const result = await audioService.speak(text);
      if (!result.success) {
        return this.error(result.error ?? '念不出来', result.error ?? 'say failed');
      }
      played.push(`已念出：${text}`);
    }

    return this.success(played.join('；'));
  }
}

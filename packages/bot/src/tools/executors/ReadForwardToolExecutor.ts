// Read forward tool executor - opens a merged-forward (聊天记录) by its forward_id

import { inject, injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ForwardedMessageNode } from '@/api/types';
import { DITokens } from '@/core/DITokens';
import { formatDateTimeShort } from '@/utils/dateTime';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';
import { clampInt } from './toolParams';

/** Nodes rendered per call when the caller does not page */
const DEFAULT_LIMIT = 200;
/** Upper bound the caller may raise `limit` to */
const MAX_LIMIT = 1000;
/**
 * Backstop on the rendered transcript so one forward can never blow up the
 * caller's context: `limit` is the caller's lever, this is the ceiling it
 * cannot cross.
 */
const MAX_TRANSCRIPT_CHARS = 20_000;

@Tool({
  name: 'read_forward',
  description:
    '读取合并转发消息（聊天记录卡片）的完整内容。消息里的 [Forward:... forward_id=xxx ...] 占位符只给出标题和前几条预览，要看全部内容就用它的 forward_id 调用本工具。默认一次返回全部消息，过长时用 offset 续读。',
  executor: 'read_forward',
  visibility: { reply: { sources: ['qq-private', 'qq-group'] }, subagent: true },
  parameters: {
    forward_id: {
      type: 'string',
      required: true,
      description: '转发消息标识符，来自消息中 [Forward:...] 占位符里的 forward_id= 字段',
    },
    limit: {
      type: 'number',
      required: false,
      description: `返回多少条转发内容（默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}）`,
    },
    offset: {
      type: 'number',
      required: false,
      description: '从第几条开始返回（0 起）。配合 limit 翻页，返回结果会写明下一页的 offset。',
    },
  },
  examples: ['看看这个聊天记录里说了什么', '这转发的内容是啥', '总结一下这份聊天记录'],
  triggerKeywords: ['聊天记录', '转发', '合并转发', '这个记录'],
  whenToUse:
    '当消息里出现 [Forward:...] 占位符，而标题和预览不足以回答用户时调用。转发里若套着另一份转发，它会渲染成新的 [Forward:...] 占位符，用其中的 forward_id 再调一次即可继续深入。',
})
@injectable()
export class ReadForwardToolExecutor extends BaseToolExecutor {
  name = 'read_forward';

  constructor(@inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const forwardId = call.parameters?.forward_id;
    if (typeof forwardId !== 'string' || !forwardId.trim()) {
      return this.error('请提供转发消息标识符 (forward_id)', 'Missing required parameter: forward_id');
    }

    const message = context.hookContext?.message;
    if (!message) {
      return this.error('当前上下文无法读取转发消息', 'No message context available');
    }

    const nodes = await this.messageAPI.getForwardedMessages(forwardId.trim(), message);
    if (!nodes) {
      return this.error('转发消息读取失败（可能已过期或协议不支持）', `Failed to read forward: ${forwardId}`);
    }
    if (nodes.length === 0) {
      return this.success('这条转发消息是空的', { forwardId, messageCount: 0, messages: [] });
    }

    const limit = clampInt(call.parameters?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(call.parameters?.offset, 0, 0, MAX_LIMIT);
    const page = nodes.slice(offset, offset + limit);
    if (page.length === 0) {
      return this.error(
        `offset=${offset} 超出范围：该转发共 ${nodes.length} 条消息`,
        `offset ${offset} out of range (${nodes.length} messages)`,
      );
    }

    const { lines, shown } = this.renderTranscript(page);
    const shownTo = offset + shown;
    const remaining = nodes.length - shownTo;

    const rangeLabel =
      shown === nodes.length ? `全部${nodes.length}条` : `第${offset + 1}-${shownTo}条 / 共${nodes.length}条`;
    const reply = [`=== 转发内容 (${rangeLabel}) ===`, lines];
    if (remaining > 0) {
      reply.push(
        '',
        `还有 ${remaining} 条未返回。用同一个 forward_id 再调用一次本工具并传 offset=${shownTo} 即可续读。`,
      );
    }

    return this.success(reply.join('\n'), {
      forwardId,
      messageCount: nodes.length,
      returnedCount: shown,
      offset,
      nextOffset: remaining > 0 ? shownTo : undefined,
      messages: page.slice(0, shown).map((n) => ({
        senderName: n.senderName,
        time: new Date(n.time).toISOString(),
        text: n.text,
      })),
    });
  }

  /** Render nodes until the transcript budget is spent; returns how many actually made it in. */
  private renderTranscript(nodes: ForwardedMessageNode[]): { lines: string; shown: number } {
    const rendered: string[] = [];
    let chars = 0;
    for (const node of nodes) {
      const line = `[${formatDateTimeShort(new Date(node.time))}] ${node.senderName}: ${node.text}`;
      if (chars + line.length > MAX_TRANSCRIPT_CHARS && rendered.length > 0) {
        break;
      }
      rendered.push(line);
      chars += line.length + 1;
    }
    return { lines: rendered.join('\n'), shown: rendered.length };
  }
}

// SessionMemoToolExecutor — exposes SessionMemoStore to the LLM via the `session_memo` tool.
// Maps action=add|delete|list directly onto store.add / store.delete / store.list.
// The store enforces the pinned XOR ttl invariant and throws on violation;
// this executor surfaces those errors as tool-level failures rather than exceptions.

import { inject, injectable } from 'tsyringe';
import type { SessionMemoItem, SessionMemoStore } from '@/conversation/memo/SessionMemoStore';
import { DITokens } from '@/core/DITokens';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

const TTL_MAP: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

@Tool({
  name: 'session_memo',
  description:
    '在跨会话短期备忘录里增删记录。用于登记 bot 认为自己下一次会话应该记得的短期信息（自己刚表达的立场、临时约定、即将发生的事等），到期自动清理；想让某条永久保留就 pinned=true 且不填 ttl。与 memory_note（长期记忆）互补：memory_note 记"用户是谁/长期规则"，session_memo 记"bot 短期想带到下一次会话的备忘"。',
  executor: 'session_memo',
  visibility: {
    reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] },
    subagent: true,
  },
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['add', 'delete', 'list'],
      description: 'add=写入新备忘 / delete=按 id 删除 / list=查看当前 session 现有备忘',
    },
    content: {
      type: 'string',
      required: false,
      description: 'action=add 时必填。要记住的内容，用第三人称清晰表述（例如"bot 已在群里表态支持 X 方案"）。',
    },
    pinned: {
      type: 'boolean',
      required: false,
      description: 'action=add 时可选。true=永久保留（此时禁止提供 ttl）；false 或省略=需要提供 ttl。',
    },
    ttl: {
      type: 'string',
      required: false,
      enum: ['1h', '6h', '1d', '3d', '7d', '30d'],
      description: 'action=add 且未 pinned 时必填。到期后此条自动清理。',
    },
    tags: {
      type: 'array',
      required: false,
      description: '可选标签，仅本地存储，不参与 prompt 渲染。',
      items: { type: 'string' },
    },
    id: {
      type: 'string',
      required: false,
      description: 'action=delete 时必填。8 位短 id，来自 list/add 的返回。',
    },
  },
  examples: [
    '刚在群里明确表态支持某方案，想让下次会话记得 → action=add pinned=false ttl=3d content="bot 已表态支持方案 A"',
    '查看现有备忘 → action=list',
    '某条备忘已经过时 → action=delete id=xxxxxxxx',
  ],
  triggerKeywords: ['备忘', '记下', '备忘录', 'memo', 'blackboard', '立场'],
  whenToUse:
    '当 bot 想在跨轮次/跨会话保留一条短期上下文（自己的立场、约定、待办等），或需要删除/查看之前已经登记的条目时。不要用来存"用户是谁"这类长期属性（那是 memory_note 的活）。',
})
@injectable()
export class SessionMemoToolExecutor extends BaseToolExecutor {
  name = 'session_memo';

  constructor(@inject(DITokens.SESSION_MEMO_STORE) private store: SessionMemoStore) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const sessionId = context.hookContext?.metadata.get('sessionId');
    if (!sessionId) {
      return this.error('无法确定当前会话，备忘工具无法使用', 'no sessionId');
    }

    const action = call.parameters?.action;
    if (action !== 'add' && action !== 'delete' && action !== 'list') {
      return this.error('action 必须为 add / delete / list 之一', 'invalid action');
    }

    if (action === 'list') {
      const items = this.store.list(sessionId);
      if (items.length === 0) {
        return this.success('当前 session 无备忘条目。', { items: [] });
      }
      const lines = items.map((item) => {
        const tag = item.pinned ? '[PIN]' : `[exp ${formatExpiry(item.expiresAt as number)}]`;
        return `- [id:${item.id}] ${tag} ${item.content}`;
      });
      const text = `当前 session 共 ${items.length} 条备忘：\n${lines.join('\n')}`;
      return this.success(text, { items });
    }

    if (action === 'add') {
      const content = typeof call.parameters?.content === 'string' ? call.parameters.content.trim() : '';
      if (!content) {
        return this.error('content 不能为空', 'empty content');
      }

      const pinned = call.parameters?.pinned === true;
      const ttlStr = typeof call.parameters?.ttl === 'string' ? call.parameters.ttl : undefined;

      if (pinned && ttlStr !== undefined) {
        return this.error('pinned=true 时不应指定 ttl', 'pinned+ttl conflict');
      }
      if (!pinned) {
        if (!ttlStr || !(ttlStr in TTL_MAP)) {
          return this.error('非 pin 备忘必须指定 ttl（1h/6h/1d/3d/7d/30d）', 'missing ttl');
        }
      }

      const ttlMs = pinned ? undefined : TTL_MAP[ttlStr as string];
      const rawTags = call.parameters?.tags;
      const tags = Array.isArray(rawTags) && rawTags.every((t) => typeof t === 'string') ? rawTags : undefined;

      let item: SessionMemoItem;
      try {
        item = this.store.add(sessionId, { content, pinned, ttlMs, tags });
      } catch (err) {
        return this.error(err instanceof Error ? err.message : String(err), 'validation');
      }

      return this.success(`已记录 [id:${item.id}]：${item.content}`, {
        id: item.id,
        pinned: item.pinned,
        expiresAt: item.expiresAt,
      });
    }

    // action === 'delete'
    const id = typeof call.parameters?.id === 'string' ? call.parameters.id.trim() : '';
    if (!id) {
      return this.error('delete 操作需要提供 id', 'missing id');
    }
    const removed = this.store.retire(sessionId, id);
    if (removed) {
      return this.success(`已删除备忘 [id:${id}]`, { deleted: true });
    }
    return this.error(`未找到备忘 id=${id}`, 'not found');
  }
}

function formatExpiry(ts: number): string {
  const d = new Date(ts);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

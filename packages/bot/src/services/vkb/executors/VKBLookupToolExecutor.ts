// LLM-callable lookup against the VKB Context Engine.
//
// Complements the per-message auto-injection (<glossary> block via
// ContextEnrichmentStage): auto-injection runs unconditionally with the
// full user message as query (broad but diluted), while this tool lets
// the LLM submit a FOCUSED keyword for higher-relevance retrieval when
// it spots a term it doesn't recognize or judges the auto-injected
// glossary insufficient.

import { inject, injectable } from 'tsyringe';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import type { VKBContextEngine } from '../VKBContextEngine';

@Tool({
  name: 'lookup_meme',
  description:
    '查询知识库中某个梗 / 网络流行词 / 黑话 / 时效性术语的释义、相关概念与真实使用语境。返回内容每条带相关度分数 [0.xx]——分数高代表知识库对该词有强匹配；分数普遍偏低说明无强匹配，按自己理解作答即可，不要硬套低相关条目。**不要在回复里暴露分数或 "lookup_meme/知识库" 等元信息**。',
  executor: 'lookup_meme',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
  parameters: {
    query: {
      type: 'string',
      required: true,
      description:
        '要查询的具体术语关键词（不要传整句话；越精确命中率越高）。例如 "鸡你太美"、"ikun"、"i柯tv"，而不是 "你知道 i柯tv 是什么吗"。',
    },
  },
  examples: ['查询 "鸡你太美" 的释义', '"ikun" 是什么梗', '想了解 "yyds" 的用法'],
  triggerKeywords: ['查梗', '什么梗', '什么意思', '这个词什么意思', '什么是', 'lookup', 'meme'],
  whenToUse:
    '当用户消息提到了你不熟悉的网络流行词 / 梗 / 黑话 / 时效性术语，或已注入的 <glossary> 块分数普遍偏低、内容不切题时调用，传精确关键词以获得更高相关度的命中。重复调用浪费 token——一个关键词查一次即可。',
})
@injectable()
export class VKBLookupToolExecutor extends BaseToolExecutor {
  name = 'lookup_meme';

  constructor(@inject('VKBContextEngine') private readonly vkbContextEngine: VKBContextEngine) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    if (!this.vkbContextEngine.isEnabled()) {
      return this.error('知识引擎未启用', 'VKB context engine disabled in config');
    }
    const query = typeof call.parameters?.query === 'string' ? call.parameters.query.trim() : '';
    if (!query) {
      return this.error('请提供要查询的术语关键词', 'Missing required parameter: query');
    }

    const glossary = await this.vkbContextEngine.fetchGlossary(query);
    if (!glossary) {
      return this.success(`知识库中未找到与 "${query}" 强相关的条目`, { query, found: false });
    }
    return this.success(glossary, { query, found: true });
  }
}

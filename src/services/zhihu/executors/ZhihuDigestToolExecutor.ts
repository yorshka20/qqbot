// ZhihuDigestToolExecutor — generates a zhihu feed digest via LLM
// Used by AgentLoop (schedule tasks) to produce daily zhihu summaries.

import { inject, injectable } from 'tsyringe';
import { ZhihuDITokens } from '@/services/zhihu/tokens';
import type { ZhihuDigestService } from '@/services/zhihu/ZhihuDigestService';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

@Tool({
  name: 'zhihu_digest',
  description: '生成知乎关注动态摘要。收集最近N小时的知乎feed数据，用LLM生成结构化摘要，包含热门回答、文章等。',
  executor: 'zhihu_digest',
  visibility: ['subagent'],
  parameters: {
    hoursBack: {
      type: 'number',
      required: false,
      description: '回溯的小时数，默认24小时。',
    },
  },
  examples: ['生成知乎日报', '获取今天的知乎动态摘要'],
  whenToUse: '当需要生成知乎关注动态的每日摘要时使用。',
})
@injectable()
export class ZhihuDigestToolExecutor extends BaseToolExecutor {
  name = 'zhihu_digest';

  constructor(@inject(ZhihuDITokens.ZHIHU_DIGEST_SERVICE) private digestService: ZhihuDigestService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const hoursBack = (call.parameters?.hoursBack as number) ?? 24;

    logger.info(`[ZhihuDigestToolExecutor] Generating digest for last ${hoursBack}h`);

    try {
      const digest = await this.digestService.generateDigestPreview(hoursBack);

      if (!digest || digest.includes('没有知乎动态')) {
        return this.success(`过去 ${hoursBack} 小时没有新的知乎动态。`);
      }

      logger.info(`[ZhihuDigestToolExecutor] Digest generated: ${digest.length} chars`);
      return this.success(digest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ZhihuDigestToolExecutor] Error:', err);
      return this.error('生成知乎摘要失败', msg);
    }
  }
}

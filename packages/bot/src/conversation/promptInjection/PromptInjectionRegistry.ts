import { injectable, singleton } from 'tsyringe';
import { logger } from '@/utils/logger';
import type { PromptInjection, PromptInjectionContext, PromptInjectionProducer } from './types';

@injectable()
@singleton()
export class PromptInjectionRegistry {
  private producers: PromptInjectionProducer[] = [];

  register(p: PromptInjectionProducer): () => void {
    this.producers.push(p);
    logger.info(
      `[PromptInjectionRegistry] producer registered | name=${p.name} | applicable=${p.applicableSources?.join(',') ?? '*'}`,
    );
    return () => {
      this.producers = this.producers.filter((x) => x !== p);
    };
  }

  async gather(ctx: PromptInjectionContext): Promise<PromptInjection[]> {
    const applicable = this.producers.filter(
      (p) => !p.applicableSources || p.applicableSources.includes(ctx.source),
    );
    const results = await Promise.all(
      applicable.map(async (p) => {
        try {
          return await p.produce(ctx);
        } catch (err) {
          logger.warn(`[PromptInjectionRegistry] producer "${p.name}" threw: ${String(err)}`);
          return null;
        }
      }),
    );
    return results
      .filter((r): r is PromptInjection => r !== null && r.fragment.length > 0)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }
}

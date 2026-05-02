import { injectable, singleton } from 'tsyringe';
import { logger } from '@/utils/logger';
import type { PromptInjection, PromptInjectionContext, PromptInjectionProducer, PromptLayer } from './types';

@injectable()
@singleton()
export class PromptInjectionRegistry {
  private producers: PromptInjectionProducer[] = [];

  register(p: PromptInjectionProducer): () => void {
    this.producers.push(p);
    logger.info(
      `[PromptInjectionRegistry] producer registered | name=${p.name} | layer=${p.layer} | applicable=${p.applicableSources?.join(',') ?? '*'}`,
    );
    return () => {
      this.producers = this.producers.filter((x) => x !== p);
    };
  }

  async gatherByLayer(ctx: PromptInjectionContext): Promise<{
    baseline: PromptInjection[];
    scene: PromptInjection[];
    runtime: PromptInjection[];
    tool: PromptInjection[];
  }> {
    const applicable = this.producers.filter(
      (p) => !p.applicableSources || p.applicableSources.includes(ctx.source),
    );
    const pairs = await Promise.all(
      applicable.map(async (p) => {
        try {
          const result = await p.produce(ctx);
          return result ? { producer: p, result } : null;
        } catch (err) {
          logger.warn(`[PromptInjectionRegistry] producer "${p.name}" threw: ${String(err)}`);
          return null;
        }
      }),
    );
    const grouped = { baseline: [], scene: [], runtime: [], tool: [] } as Record<PromptLayer, PromptInjection[]>;
    for (const pair of pairs) {
      if (!pair) continue;
      if (!pair.result.fragment || pair.result.fragment.length === 0) continue;
      grouped[pair.producer.layer].push(pair.result);
    }
    for (const layer of Object.keys(grouped) as PromptLayer[]) {
      grouped[layer].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }
    return grouped;
  }
}

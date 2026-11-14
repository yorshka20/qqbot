interface AnthropicModelInfo {
  max_tokens: number;
}

/**
 * Output-token ceilings of Anthropic models, read from the Models API
 * (`GET /v1/models/{id}` → `max_tokens`) once per model per process.
 *
 * Anthropic requests ask for the model's own ceiling: any lower cap is a policy
 * truncation, and with adaptive thinking it also cuts the chain of thought, which is
 * charged against the same budget. The ceiling differs per model (128K on current
 * models, 64K on Haiku 4.5), and a value above it is a 400, so it is looked up rather
 * than written down.
 */
export class AnthropicModelLimits {
  private readonly limits = new Map<string, Promise<number>>();

  constructor(private readonly getModel: (model: string) => Promise<AnthropicModelInfo>) {}

  /** The model's ceiling, or `requested` when a caller asks for less. */
  async maxTokens(model: string, requested?: number): Promise<number> {
    const ceiling = await this.ceiling(model);
    if (requested === undefined) {
      return ceiling;
    }
    return Math.min(Math.max(1, Math.floor(requested)), ceiling);
  }

  private ceiling(model: string): Promise<number> {
    const known = this.limits.get(model);
    if (known) {
      return known;
    }
    const lookup = this.getModel(model).then((info) => info.max_tokens);
    // A failed lookup is not remembered, so the next request asks again.
    lookup.catch(() => this.limits.delete(model));
    this.limits.set(model, lookup);
    return lookup;
  }
}

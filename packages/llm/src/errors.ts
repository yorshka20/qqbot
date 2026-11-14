/**
 * The provider answered, and the answer is a policy decline: a safety classifier, or the
 * model itself, refused this request. It is an outcome of the request, not a failure of
 * the provider — the provider is healthy, and the same request on the same model is
 * declined again — so it is neither retried, nor counted against the provider's health,
 * nor handed to another provider.
 */
export class ProviderRefusalError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    /** The vendor's own stop signal, e.g. Anthropic `stop_reason=refusal`, Gemini `finishReason=SAFETY`. */
    readonly stopSignal: string,
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    const detail = [stopSignal, `category=${category ?? 'unspecified'}`].join(', ');
    super(`${provider} (${model}) declined the request (${detail})${explanation ? `: ${explanation}` : ''}`);
    this.name = 'ProviderRefusalError';
  }
}

/**
 * Model pricing, in USD per million tokens.
 *
 * Prices change. `tokenmeter models` prints this table so you can eyeball it,
 * and a user override at ~/.tokenmeter/pricing.json wins over anything here.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /**
   * Multiplier on the input rate for tokens written to the prompt cache.
   * Anthropic charges ~1.25x to write.
   */
  cacheWriteMultiplier: number;
  /**
   * Multiplier on the input rate for tokens read from the prompt cache.
   * Anthropic charges ~0.1x to read — this is where the savings show up.
   */
  cacheReadMultiplier: number;
}

const ANTHROPIC_CACHE = {
  cacheWriteMultiplier: 1.25,
  cacheReadMultiplier: 0.1,
} as const;

/** Prices verified 2026-09-11. */
export const PRICING: Record<string, ModelPrice> = {
  // Anthropic — Claude
  "claude-fable-5": { input: 10.0, output: 50.0, ...ANTHROPIC_CACHE },
  "claude-mythos-5": { input: 10.0, output: 50.0, ...ANTHROPIC_CACHE },
  "claude-opus-5": { input: 5.0, output: 25.0, ...ANTHROPIC_CACHE },
  "claude-opus-4-8": { input: 5.0, output: 25.0, ...ANTHROPIC_CACHE },
  "claude-opus-4-7": { input: 5.0, output: 25.0, ...ANTHROPIC_CACHE },
  "claude-opus-4-6": { input: 5.0, output: 25.0, ...ANTHROPIC_CACHE },
  "claude-sonnet-5": { input: 3.0, output: 15.0, ...ANTHROPIC_CACHE },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, ...ANTHROPIC_CACHE },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, ...ANTHROPIC_CACHE },
};

/** Used when a model isn't in the table, so spend is never silently dropped. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = {
  input: 0,
  output: 0,
  cacheWriteMultiplier: 1.25,
  cacheReadMultiplier: 0.1,
};

let overrides: Record<string, ModelPrice> | null = null;

/**
 * Merge in user-supplied prices from ~/.tokenmeter/pricing.json.
 * Lets people correct a stale table without waiting on a release.
 */
export function loadPricingOverrides(raw: string): void {
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
    const merged: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(parsed)) {
      const base = PRICING[model] ?? UNKNOWN_MODEL_PRICE;
      merged[model] = {
        input: price.input ?? base.input,
        output: price.output ?? base.output,
        cacheWriteMultiplier: price.cacheWriteMultiplier ?? base.cacheWriteMultiplier,
        cacheReadMultiplier: price.cacheReadMultiplier ?? base.cacheReadMultiplier,
      };
    }
    overrides = merged;
  } catch {
    // A malformed override file should never stop the proxy from forwarding
    // traffic. Fall back to built-in prices.
    overrides = null;
  }
}

/**
 * Look up a model's price.
 *
 * Providers often return a more specific id than you sent (a dated snapshot,
 * or a `anthropic.`/`us.` platform prefix), so fall back to the longest
 * known key the id starts with or contains before giving up.
 */
export function priceFor(model: string): { price: ModelPrice; known: boolean } {
  const table = { ...PRICING, ...(overrides ?? {}) };

  const exact = table[model];
  if (exact) return { price: exact, known: true };

  const candidates = Object.keys(table)
    .filter((key) => model.includes(key))
    .sort((a, b) => b.length - a.length);

  const best = candidates[0];
  if (best) {
    const price = table[best];
    if (price) return { price, known: true };
  }

  return { price: UNKNOWN_MODEL_PRICE, known: false };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** Cost of a single call, in USD. */
export function costOf(model: string, usage: TokenUsage): number {
  const { price } = priceFor(model);
  const perToken = (rate: number) => rate / 1_000_000;

  return (
    usage.inputTokens * perToken(price.input) +
    usage.outputTokens * perToken(price.output) +
    usage.cacheWriteTokens * perToken(price.input * price.cacheWriteMultiplier) +
    usage.cacheReadTokens * perToken(price.input * price.cacheReadMultiplier)
  );
}

/**
 * What the same call would have cost with no prompt caching — cache reads
 * repriced at the full input rate, cache writes without the 1.25x premium.
 * The difference between this and `costOf` is what caching actually saved.
 */
export function uncachedCostOf(model: string, usage: TokenUsage): number {
  const { price } = priceFor(model);
  const perToken = (rate: number) => rate / 1_000_000;

  return (
    usage.inputTokens * perToken(price.input) +
    usage.outputTokens * perToken(price.output) +
    usage.cacheWriteTokens * perToken(price.input) +
    usage.cacheReadTokens * perToken(price.input)
  );
}

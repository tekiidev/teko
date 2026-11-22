// Custo estimado de uma chamada, considerando tokens servidos do cache do provider.
//
// Convenção de uso normalizada pelos adapters:
//   inputTokens        total de tokens de entrada (inclui os em cache)
//   cachedInputTokens  parte da entrada lida do cache (mais barata)
//   cacheWriteTokens   parte da entrada gravada no cache (Anthropic cobra um pouco a mais)
//   outputTokens       tokens de saída

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
};

// Multiplicadores sobre o preço de entrada. Valores públicos de cada provider;
// quando o desconto não é conhecido, assume preço cheio (estimativa conservadora).
const CACHE_RATES: Record<string, { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.1, write: 1 },
  google: { read: 0.25, write: 1 },
  deepseek: { read: 0.1, write: 1 },
};
const DEFAULT_RATE = { read: 1, write: 1 };

export function cacheRates(providerId: string | null | undefined) {
  return (providerId && CACHE_RATES[providerId]) || DEFAULT_RATE;
}

function n(value: unknown) {
  const x = Number(value);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Normaliza os números e garante cached + write <= input. */
export function normalizeUsage(usage: Usage = {}) {
  const inputTokens = n(usage.inputTokens);
  const cachedInputTokens = Math.min(n(usage.cachedInputTokens), inputTokens);
  const cacheWriteTokens = Math.min(n(usage.cacheWriteTokens), inputTokens - cachedInputTokens);
  return { inputTokens, outputTokens: n(usage.outputTokens), cachedInputTokens, cacheWriteTokens };
}

export function computeCost(
  model: { price_in?: number; price_out?: number },
  providerId: string | null | undefined,
  usage: Usage,
) {
  const u = normalizeUsage(usage);
  const rates = cacheRates(providerId);
  const priceIn = n(model.price_in) / 1_000_000;
  const priceOut = n(model.price_out) / 1_000_000;
  const fresh = u.inputTokens - u.cachedInputTokens - u.cacheWriteTokens;
  const cost =
    fresh * priceIn +
    u.cachedInputTokens * priceIn * rates.read +
    u.cacheWriteTokens * priceIn * rates.write +
    u.outputTokens * priceOut;
  // Quanto custaria sem nenhum cache: base da métrica de economia.
  const costWithoutCache = u.inputTokens * priceIn + u.outputTokens * priceOut;
  return { cost, costWithoutCache, saved: Math.max(0, costWithoutCache - cost) };
}

/** Soma dois registros de uso (rodadas do loop de ferramentas). */
export function addUsage(a: Usage, b: Usage) {
  const x = normalizeUsage(a);
  const y = normalizeUsage(b);
  return {
    inputTokens: x.inputTokens + y.inputTokens,
    outputTokens: x.outputTokens + y.outputTokens,
    cachedInputTokens: x.cachedInputTokens + y.cachedInputTokens,
    cacheWriteTokens: x.cacheWriteTokens + y.cacheWriteTokens,
  };
}

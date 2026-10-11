// USD rates per million text tokens, checked against provider pricing on 2026-10-11.
// A cached OpenAI input token is part of input_tokens; Anthropic reports cache
// reads and writes separately from input_tokens. Unsupported models have no estimate.
export const PRICING_DATE = '2026-10-11';
export const PRICING_SOURCES = {
  openai: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
};
const RATES_NANO = {
  'openai:gpt-4.1-mini': { input: 400, cached: 100, output: 1600 },
  'anthropic:claude-sonnet-5-5': { input: 2000, cached: 100, cacheWrite: 2500, output: 10000 },
};
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function measuredUsage(provider, model, usage) {
  const inputTokens = token(usage?.input);
  const outputTokens = token(usage?.output);
  if (inputTokens === null || outputTokens === null) return null;
  if ((usage.cachedInput !== undefined && token(usage.cachedInput) === null) ||
      (usage.cacheCreationInput !== undefined && token(usage.cacheCreationInput) === null)) return null;
  const cachedInputTokens = token(usage?.cachedInput) ?? 0;
  const cacheCreationInputTokens = token(usage?.cacheCreationInput) ?? 0;
  if (provider === 'openai' && cachedInputTokens > inputTokens) return null;
  const rates = RATES_NANO[`${provider}:${model}`];
  const estimatedCostNanoUsd = rates ? (provider === 'openai'
    ? (inputTokens - cachedInputTokens) * rates.input + cachedInputTokens * rates.cached + outputTokens * rates.output
    : inputTokens * rates.input + cachedInputTokens * rates.cached + cacheCreationInputTokens * rates.cacheWrite + outputTokens * rates.output) : null;
  return { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens,
    estimatedCostNanoUsd: Number.isSafeInteger(estimatedCostNanoUsd) ? estimatedCostNanoUsd : null };
}

export function usageReceipt(provider, model, usage) {
  const measured = measuredUsage(provider, model, usage);
  return { provider, model, state: measured ? 'measured' : 'unreported',
    ...(measured ?? { inputTokens: null, outputTokens: null, cachedInputTokens: null,
      cacheCreationInputTokens: null, estimatedCostNanoUsd: null }), pricingDate: PRICING_DATE };
}

export function summarizeUsage(records) {
  const total = { calls: 0, measuredCalls: 0, unreportedCalls: 0, pendingCalls: 0,
    inputTokens: 0, outputTokens: 0, estimatedCostNanoUsd: 0, unpricedCalls: 0 };
  const agents = {};
  for (const record of records) {
    const target = agents[record.agent] ??= { ...total };
    for (const value of [total, target]) {
      value.calls++;
      if (record.state === 'pending') { value.pendingCalls++; continue; }
      if (record.state !== 'measured') { value.unreportedCalls++; continue; }
      value.measuredCalls++;
      value.inputTokens += Number(record.inputTokens ?? 0) + (record.provider === 'anthropic' ? Number(record.cachedInputTokens ?? 0) + Number(record.cacheCreationInputTokens ?? 0) : 0);
      value.outputTokens += Number(record.outputTokens ?? 0);
      if (record.estimatedCostNanoUsd === null || record.estimatedCostNanoUsd === undefined) value.unpricedCalls++;
      else value.estimatedCostNanoUsd += Number(record.estimatedCostNanoUsd);
    }
  }
  return { total, agents };
}

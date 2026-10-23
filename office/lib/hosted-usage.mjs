import { usageReceipt, summarizeUsage, PRICING_DATE, PRICING_SOURCES } from './usage.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALL_ID = /^[A-Za-z0-9:_-]{1,150}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function createHostedUsage({ query, auth }) {
  if (typeof query !== 'function' || typeof auth?.authorize !== 'function') throw new Error('Usage storage requires database and auth');
  function owner(cookie) {
    const access = auth.authorize(cookie);
    if (access.status !== 200 || typeof access.sub !== 'string' || !access.sub) throw new Error('Office access denied');
    return access.sub;
  }
  return {
    async begin(cookie, { callId, projectId, agent, provider, model, month }) {
      if (!CALL_ID.test(callId) || !UUID.test(projectId) || !['Maya', 'Sam', 'Quinn'].includes(agent) ||
          !['openai', 'anthropic', 'mock'].includes(provider) || typeof model !== 'string' || model.length > 100 || !MONTH.test(month)) throw new Error('Invalid usage claim');
      await query(`INSERT INTO village_provider_usage (owner_sub, call_id, project_id, agent, provider, model, month)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [owner(cookie), callId, projectId, agent, provider, model, month]);
    },
    async complete(cookie, callId, provider, model, usage) {
      if (!CALL_ID.test(callId)) throw new Error('Invalid usage claim');
      const receipt = usageReceipt(provider, model, usage);
      await query(`UPDATE village_provider_usage SET state = $3, input_tokens = $4, output_tokens = $5,
        cached_input_tokens = $6, cache_creation_input_tokens = $7, estimated_cost_nano_usd = $8,
        completed_at = now() WHERE owner_sub = $1 AND call_id = $2 AND state = 'pending'`,
      [owner(cookie), callId, receipt.state, receipt.inputTokens, receipt.outputTokens,
        receipt.cachedInputTokens, receipt.cacheCreationInputTokens, receipt.estimatedCostNanoUsd]);
      return receipt;
    },
    async summary(cookie, { projectId = null, month = new Date().toISOString().slice(0, 7) } = {}) {
      if ((projectId !== null && !UUID.test(projectId)) || !MONTH.test(month)) throw new Error('Invalid usage query');
      const sub = owner(cookie);
      const fields = `call_id, project_id, agent, provider, model, state, month,
        input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, estimated_cost_nano_usd, started_at`;
      const monthly = await query(`SELECT ${fields} FROM village_provider_usage WHERE owner_sub = $1 AND month = $2 ORDER BY started_at DESC LIMIT 100`, [sub, month]);
      const project = projectId ? await query(`SELECT ${fields} FROM village_provider_usage WHERE owner_sub = $1 AND project_id = $2 ORDER BY started_at DESC LIMIT 500`, [sub, projectId]) : { rows: [] };
      const map = row => ({ callId: row.call_id, projectId: row.project_id, agent: row.agent, provider: row.provider, model: row.model,
        state: row.state, month: row.month, inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
        outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
        cachedInputTokens: row.cached_input_tokens === null ? null : Number(row.cached_input_tokens),
        cacheCreationInputTokens: row.cache_creation_input_tokens === null ? null : Number(row.cache_creation_input_tokens),
        estimatedCostNanoUsd: row.estimated_cost_nano_usd === null ? null : Number(row.estimated_cost_nano_usd), startedAt: row.started_at });
      const monthRows = monthly.rows.map(map); const projectRows = project.rows.map(map);
      return { month, pricingDate: PRICING_DATE, pricingSources: PRICING_SOURCES,
        monthly: { ...summarizeUsage(monthRows), truncated: monthRows.length >= 100 },
        project: { ...summarizeUsage(projectRows), truncated: projectRows.length >= 500 }, calls: projectRows };
    },
  };
}

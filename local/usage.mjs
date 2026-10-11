import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measuredUsage, summarizeUsage, PRICING_DATE, PRICING_SOURCES } from '../office/lib/usage.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const safeModel = value => typeof value === 'string' && value.length <= 80 && /^(?:gpt-|claude-|o[0-9])[A-Za-z0-9._-]*$/.test(value) ? value : value === 'deterministic' ? value : 'unknown';
function safeCall(event) {
  if (!timestamp(event.at)) return null;
  const provider = ['openai', 'anthropic', 'mock'].includes(event.provider) ? event.provider : 'unknown';
  const model = safeModel(event.model);
  const agent = ['Maya', 'Sam', 'Quinn'].includes(event.agent) ? event.agent : 'Agent';
  const state = ['pending', 'unreported', 'measured'].includes(event.state) ? event.state : 'unreported';
  const measured = state === 'measured' ? measuredUsage(provider, model, {
    input: event.inputTokens, output: event.outputTokens,
    cachedInput: event.cachedInputTokens, cacheCreationInput: event.cacheCreationInputTokens,
  }) : null;
  return { at: event.at, agent, provider, model, state: state === 'measured' && !measured ? 'unreported' : state,
    inputTokens: measured?.inputTokens ?? null, outputTokens: measured?.outputTokens ?? null,
    cachedInputTokens: measured?.cachedInputTokens ?? null, cacheCreationInputTokens: measured?.cacheCreationInputTokens ?? null,
    estimatedCostNanoUsd: measured?.estimatedCostNanoUsd ?? null, pricingDate: PRICING_DATE };
}
export async function readLocalUsage({ root, projectId = null, month = new Date().toISOString().slice(0, 7) }) {
  if ((projectId !== null && !UUID.test(projectId)) || !MONTH.test(month)) throw new Error('Invalid usage query');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
  const monthCalls = []; const projectCalls = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    let state;
    try {
      const path = join(root, entry.name, 'state.json');
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) continue;
      state = JSON.parse(await readFile(path, 'utf8'));
    }
    catch { continue; }
    if (state.id !== entry.name || !Array.isArray(state.events)) continue;
    const unique = new Map();
    for (const event of state.events) if (event && event.type === 'usage' && typeof event.callId === 'string' && event.callId.length <= 120) {
      const call = safeCall(event);
      if (call) unique.set(event.callId, call);
    }
    for (const call of unique.values()) {
      if (call.at?.slice(0, 7) === month) monthCalls.push(call);
      if (entry.name === projectId) projectCalls.push(call);
    }
  }
  projectCalls.sort((a, b) => b.at.localeCompare(a.at));
  return { month, pricingDate: PRICING_DATE, pricingSources: PRICING_SOURCES,
    monthly: summarizeUsage(monthCalls), project: summarizeUsage(projectCalls), calls: projectCalls };
}

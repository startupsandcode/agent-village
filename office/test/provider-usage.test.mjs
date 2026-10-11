import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../lib/provider.mjs';

test('provider captures cache and token fields from both successful responses', async () => {
  const openai = createProvider({ env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: async () => ({ ok: true, json: async () => ({
    status: 'completed', output_text: '{"question":"Who?"}', usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 25 } },
  }) }) });
  assert.deepEqual((await openai.generate({ system: 'x', input: 'y' })).usage, { input: 100, output: 20, cachedInput: 25 });
  const anthropic = createProvider({ name: 'anthropic', env: { ANTHROPIC_API_KEY: 'test-key' }, fetchImpl: async () => ({ ok: true, json: async () => ({
    stop_reason: 'end_turn', content: [{ type: 'text', text: '{"question":"Who?"}' }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
  }) }) });
  assert.deepEqual((await anthropic.generate({ system: 'x', input: 'y' })).usage,
    { input: 100, output: 20, cachedInput: 30, cacheCreationInput: 10 });
});

test('truncated and invalid provider results retain reported usage for an error receipt', async () => {
  const provider = createProvider({ env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: async () => ({ ok: true, json: async () => ({
    status: 'incomplete', usage: { input_tokens: 7, output_tokens: 3 },
  }) }) });
  await assert.rejects(provider.generate({ system: 'x', input: 'y' }), error => {
    assert.match(error.message, /truncated/);
    assert.deepEqual(error.usage, { input: 7, output: 3, cachedInput: 0 });
    return true;
  });
  const missing = createProvider({ env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output_text: '{"question":"Who?"}' }) }) });
  assert.equal((await missing.generate({ system: 'x', input: 'y' })).usage, null);
});

test('OpenAI review requests constrain the three review fields with a strict output schema', async () => {
  let body;
  const provider = createProvider({ env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: async (_url, request) => {
    body = JSON.parse(request.body);
    return { ok: true, json: async () => ({ status: 'completed', output_text: '{"approved":true,"summary":"Matches","findings":[]}' }) };
  } });
  const reply = await provider.generate({ system: 'Review the site', input: '{}', format: 'review' });
  assert.equal(reply.result.approved, true);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema.required, ['approved', 'summary', 'findings']);
  assert.equal(body.text.format.schema.additionalProperties, false);
});

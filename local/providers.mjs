const TIMEOUT_MS = 45000;

function pickText(value) {
  const match = String(value).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Provider returned no JSON result');
  try { return JSON.parse(match[0]); } catch { throw new Error('Provider returned invalid JSON'); }
}

async function post(url, headers, body, { fetchImpl, signal }) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = AbortSignal.any([signal ?? new AbortController().signal, timeout]);
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
  } catch {
    if (combined.aborted) throw new Error(signal?.aborted ? 'Request cancelled' : 'Provider timed out');
    throw new Error('Provider connection failed');
  }
  if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
  let data;
  try { data = await response.json(); } catch { throw new Error('Provider returned invalid response'); }
  return data;
}

export function createProvider({ name = process.env.VILLAGE_PROVIDER ?? 'openai', env = process.env, fetchImpl = fetch } = {}) {
  if (!['openai', 'anthropic'].includes(name)) throw new Error('VILLAGE_PROVIDER must be openai or anthropic');
  const key = name === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!key) throw new Error(`Missing ${name === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} on the server`);
  const model = name === 'openai' ? (env.VILLAGE_OPENAI_MODEL ?? 'gpt-4.1-mini') : (env.VILLAGE_ANTHROPIC_MODEL ?? 'claude-sonnet-5-5');
  return {
    name, model,
    containsSecret(value) { return key.length >= 8 && String(value).includes(key); },
    redact(value) { return key.length >= 8 ? String(value).replaceAll(key, '[redacted]') : String(value); },
    async generate({ system, input, signal }) {
      if (name === 'openai') {
        const data = await post('https://api.openai.com/v1/responses', {
          authorization: `Bearer ${key}`, 'content-type': 'application/json',
        }, { model, instructions: system, input, max_output_tokens: 1800 }, { fetchImpl, signal });
        const text = data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('') ?? '';
        return { result: pickText(text), usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
      }
      const data = await post('https://api.anthropic.com/v1/messages', {
        'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
      }, { model, max_tokens: 1800, system, messages: [{ role: 'user', content: input }] }, { fetchImpl, signal });
      const text = data.content?.filter(item => item.type === 'text').map(item => item.text).join('') ?? '';
      return { result: pickText(text), usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
    },
  };
}

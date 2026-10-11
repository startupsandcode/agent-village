const TIMEOUT_MS = 45000;
const MAX_INPUT_BYTES = 32_768;

function pickText(value) {
  const match = String(value).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Provider returned no JSON result');
  try { return JSON.parse(match[0]); } catch { throw new Error('Provider returned invalid JSON'); }
}

async function post(url, headers, body, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let abortListener;
  const aborted = new Promise((_resolve, reject) => {
    abortListener = () => reject(new Error('Provider request aborted'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (controller.signal.aborted) abortListener();
  });
  let response, data, invalidResponse = false;
  try {
    response = await Promise.race([fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal }), aborted]);
    if (response.ok) {
      try { data = await Promise.race([response.json(), aborted]); } catch { invalidResponse = true; }
    }
  } catch {
    if (signal?.aborted) throw new Error('Request cancelled');
    if (timedOut) throw new Error('Provider timed out');
    throw new Error('Provider connection failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abortListener);
  }
  if (signal?.aborted) throw new Error('Request cancelled');
  if (timedOut) throw new Error('Provider timed out');
  if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
  if (invalidResponse) throw new Error('Provider returned invalid response');
  return data;
}

export function createProvider({ name = process.env.VILLAGE_PROVIDER ?? 'openai', env = process.env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!['openai', 'anthropic'].includes(name)) throw new Error('VILLAGE_PROVIDER must be openai or anthropic');
  const key = name === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!key) throw new Error(`Missing ${name === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} on the server`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new Error('Invalid provider timeout');
  const model = name === 'openai' ? (env.VILLAGE_OPENAI_MODEL ?? 'gpt-4.1-mini') : (env.VILLAGE_ANTHROPIC_MODEL ?? 'claude-sonnet-5-5');
  return {
    name, model,
    containsSecret(value) { return key.length >= 8 && String(value).includes(key); },
    redact(value) { return key.length >= 8 ? String(value).replaceAll(key, '[redacted]') : String(value); },
    async generate({ system, input, signal }) {
      if (typeof system !== 'string' || typeof input !== 'string' || Buffer.byteLength(system) + Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error('Provider input exceeds project limit');
      if (name === 'openai') {
        const data = await post('https://api.openai.com/v1/responses', {
          authorization: `Bearer ${key}`, 'content-type': 'application/json',
        }, { model, instructions: system, input, max_output_tokens: 1800 }, { fetchImpl, signal, timeoutMs });
        if (data.status !== 'completed') throw new Error(data.status === 'incomplete' ? 'Provider output truncated at token limit' : 'Provider did not complete');
        const text = data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('') ?? '';
        return { result: pickText(text), usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
      }
      const data = await post('https://api.anthropic.com/v1/messages', {
        'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
      }, { model, max_tokens: 1800, system, messages: [{ role: 'user', content: input }],
        ...(model.startsWith('claude-sonnet-5-5') ? { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } } : {}),
      }, { fetchImpl, signal, timeoutMs });
      if (data.stop_reason !== 'end_turn') throw new Error(data.stop_reason === 'max_tokens' ? 'Provider output truncated at token limit' : 'Provider did not complete');
      const text = data.content?.filter(item => item.type === 'text').map(item => item.text).join('') ?? '';
      return { result: pickText(text), usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
    },
  };
}

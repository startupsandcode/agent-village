import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyCodexSchemaRejection } from '../mission-preexecution-recovery.mjs';

const mission = { id: 'preview-validation-20261024', artifactId: 'village-preview-20261024' };
const sessionId = '01a16ed9-f8cb-73f2-836b-61c8445aa29e';

async function evidenceFixture(t, { prompt = true, assistant = false, errorCode = 'invalid_json_schema' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'village-preflight-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspacePath = join(root, 'workspace');
  const codexHome = join(root, '.codex');
  const directory = join(codexHome, 'sessions', '2026', '10', '24');
  await mkdir(workspacePath);
  await mkdir(directory, { recursive: true });
  const records = [
    { type: 'session_meta', payload: { session_id: sessionId, cwd: workspacePath } },
    { type: 'response_item', payload: { type: 'additional_tools', role: 'developer' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: prompt ? `You are Susie, the product designer. Mission ${mission.id}; artifact ${mission.artifactId}.` :
        `You are Susie. Mission ${mission.id}; artifact other-artifact.` }] } },
  ];
  if (assistant) records.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } });
  const error = { error: { code: errorCode, param: 'text.format.schema',
    message: "Invalid schema for response_format 'codex_output_schema': 'schema.required' is required to include every key in properties. Missing 'artifactPath'." }, status: 400 };
  records.push({ type: 'event_msg', payload: { type: 'task_complete', error: { message: JSON.stringify(error) } } });
  const sessionPath = join(directory, `rollout-2026-10-24T12-59-01-${sessionId}.jsonl`);
  await writeFile(sessionPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return { root, workspacePath, codexHome, sessionPath };
}

test('proof accepts only a matching pre-execution schema rejection from this mission and workspace', async t => {
  const evidence = await evidenceFixture(t);
  const proof = await verifyCodexSchemaRejection({ ...evidence, mission });
  assert.equal(proof.sessionId, sessionId);
  assert.equal(proof.errorCode, 'invalid_json_schema');
  assert.equal(proof.missingField, 'artifactPath');
  assert.match(proof.evidenceSha256, /^[a-f0-9]{64}$/);
});

test('proof rejects mismatched mission prompts, assistant output, and unrelated provider errors', async t => {
  for (const options of [{ prompt: false }, { assistant: true }, { errorCode: 'rate_limit_exceeded' }]) {
    const evidence = await evidenceFixture(t, options);
    await assert.rejects(verifyCodexSchemaRejection({ ...evidence, mission }), /does not contain|contains assistant|does not prove/);
  }
});

test('proof rejects session logs outside Codex sessions', async t => {
  const evidence = await evidenceFixture(t);
  const outsidePath = join(evidence.root, 'copied-session.jsonl');
  await writeFile(outsidePath, await (await import('node:fs/promises')).readFile(evidence.sessionPath));
  await assert.rejects(verifyCodexSchemaRejection({ ...evidence, sessionPath: outsidePath, mission }), /local sessions directory/);
});

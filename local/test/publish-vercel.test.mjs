import test from 'node:test';
import assert from 'node:assert/strict';
import { deployReviewedPreview } from '../publish-vercel.mjs';
import { artifactDigest } from '../artifact.mjs';

const engine = { async get() { return { status: 'reviewed', artifact: { sha256: artifactDigest('<h1>Reviewed</h1>', 'h1{color:teal}') } }; },
  async artifact(_id, file) { return file === 'index.html' ? '<h1>Reviewed</h1>' : 'h1{color:teal}'; } };
const inputs = { engine, id: '00000000-0000-4000-8000-000000000001', team: 'small-team', project: 'small-site', token: 'fake-test-token' };
function fakeFetch(calls) { return async (url, options) => {
  calls.push({ url, options });
  if (options.method === 'POST') return { ok: true, json: async () => ({ id: 'dpl_abcdef1234', url: 'small-site-abc.vercel.app', target: null, readyState: 'QUEUED' }) };
  return { ok: true, json: async () => ({ id: 'prj_abcdef1234', name: 'small-site', framework: null, rootDirectory: null }) };
}; }

test('Preview upload is explicit, scoped to an existing static project, and contains reviewed files only', async () => {
  const calls = [];
  const stages = [];
  const result = await deployReviewedPreview({ ...inputs, fetchImpl: fakeFetch(calls), onBeforeSubmit: target => { stages.push({ target, count: calls.length }); } });
  assert.equal(result.url, 'https://small-site-abc.vercel.app');
  assert.equal(result.state, 'QUEUED');
  assert.equal(calls.length, 2);
  assert.equal(stages[0].count, 1);
  assert.equal(stages[0].target.projectId, 'prj_abcdef1234');
  assert.match(calls[0].url, /\/v9\/projects\/small-site\?slug=small-team$/);
  assert.match(calls[1].url, /\/v13\/deployments\?slug=small-team$/);
  const sent = JSON.parse(calls[1].options.body);
  assert.equal(sent.project, 'prj_abcdef1234');
  assert.equal(sent.target, undefined);
  assert.deepEqual(sent.files.map(file => file.file), ['index.html', 'styles.css']);
  assert.equal(Buffer.from(sent.files[0].data, 'base64').toString(), '<h1>Reviewed</h1>');
  assert.ok(!JSON.stringify(sent).includes(inputs.token));
});

test('wrong target and unreviewed site cause no deployment write', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    return { ok: true, json: async () => ({ id: 'prj_abcdef1234', name: 'different', framework: null }) };
  };
  await assert.rejects(deployReviewedPreview({ ...inputs, fetchImpl }), /existing static project/);
  assert.equal(calls.length, 1);
  await assert.rejects(deployReviewedPreview({ ...inputs, project: '../wrong', fetchImpl }), /Exact Vercel/);
  await assert.rejects(deployReviewedPreview({ ...inputs, engine: { async get() { return { status: 'blocked' }; } }, fetchImpl }), /Only a reviewed/);
  assert.equal(calls.length, 1);
});

test('changed captured files cannot be uploaded with a reviewed receipt', async () => {
  const calls = [];
  const changed = { ...engine, async artifact(_id, file) { return file === 'index.html' ? '<h1>Changed</h1>' : 'h1{color:teal}'; } };
  await assert.rejects(deployReviewedPreview({ ...inputs, engine: changed, fetchImpl: fakeFetch(calls) }), /Reviewed files changed/);
  assert.equal(calls.length, 0);
});

test('Vercel errors and credential absence do not expose response or token', async () => {
  await assert.rejects(deployReviewedPreview({ ...inputs, token: '' }), /token missing/);
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'secret response body' });
  const error = await deployReviewedPreview({ ...inputs, fetchImpl }).then(() => null, value => value);
  assert.match(error.message, /Vercel request failed \(401\)/);
  assert.doesNotMatch(error.message, /secret|fake-test-token/);
});

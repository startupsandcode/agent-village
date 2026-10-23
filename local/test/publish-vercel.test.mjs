import test from 'node:test';
import assert from 'node:assert/strict';
import { deployReviewedPreview, UnsafeVercelDeploymentError } from '../publish-vercel.mjs';
import { artifactDigest } from '../artifact.mjs';

const engine = { async get() { return { status: 'reviewed', artifact: { sha256: artifactDigest('<h1>Reviewed</h1>', 'h1{color:teal}') } }; },
  async artifact(_id, file) { return file === 'index.html' ? '<h1>Reviewed</h1>' : 'h1{color:teal}'; } };
const inputs = { engine, id: '00000000-0000-4000-8000-000000000001', team: 'small-team', project: 'small-site', token: 'fake-test-token' };
function fakeFetch(calls) { return async (url, options) => {
  calls.push({ url, options });
  if (options.method === 'POST') return { ok: true, json: async () => ({ id: 'dpl_abcdef1234', url: 'small-site-abc.vercel.app', target: null, readyState: 'QUEUED' }) };
  if (url.includes('/v7/deployments')) return { ok: true, json: async () => ({ deployments: [{ id: 'dpl_existing123', projectId: 'prj_abcdef1234', target: 'production', state: 'READY' }] }) };
  return { ok: true, json: async () => ({ id: 'prj_abcdef1234', name: 'small-site', framework: null, rootDirectory: null,
    ssoProtection: { deploymentType: 'all' }, protectionBypass: null }) };
}; }

test('Preview upload is explicit, scoped to an existing static project, and contains reviewed files only', async () => {
  const calls = [];
  const stages = [];
  const result = await deployReviewedPreview({ ...inputs, fetchImpl: fakeFetch(calls), onBeforeSubmit: target => { stages.push({ target, count: calls.length }); } });
  assert.equal(result.url, 'https://small-site-abc.vercel.app');
  assert.equal(result.state, 'QUEUED');
  assert.equal(calls.length, 3);
  assert.equal(stages[0].count, 2);
  assert.equal(stages[0].target.projectId, 'prj_abcdef1234');
  assert.match(calls[0].url, /\/v9\/projects\/small-site\?slug=small-team$/);
  assert.match(calls[1].url, /\/v7\/deployments\?projectId=prj_abcdef1234&target=production&limit=1&slug=small-team$/);
  assert.match(calls[2].url, /\/v13\/deployments\?slug=small-team$/);
  const sent = JSON.parse(calls[2].options.body);
  assert.equal(sent.project, 'prj_abcdef1234');
  assert.equal(sent.target, undefined);
  assert.equal(sent.autoAssignCustomDomains, false);
  assert.deepEqual(sent.projectSettings, { framework: null, buildCommand: '' });
  assert.deepEqual(sent.files.map(file => file.file), ['index.html', 'styles.css']);
  assert.equal(Buffer.from(sent.files[0].data, 'base64').toString(), '<h1>Reviewed</h1>');
  assert.ok(!JSON.stringify(sent).includes(inputs.token));
});

test('an empty Vercel project cannot receive a first deployment through the Preview action', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/v7/deployments')) return { ok: true, json: async () => ({ deployments: [] }) };
    return { ok: true, json: async () => ({ id: 'prj_abcdef1234', name: 'small-site', framework: null,
      ssoProtection: { deploymentType: 'all' } }) };
  };
  await assert.rejects(deployReviewedPreview({ ...inputs, fetchImpl }), /existing production deployment/);
  assert.deepEqual(calls.map(call => call.options.method ?? 'GET'), ['GET', 'GET']);
});

test('Preview upload requires All Deployments protection without configured bypasses', async () => {
  for (const project of [
    { ssoProtection: { deploymentType: 'all_except_custom_domains' } },
    { ssoProtection: { deploymentType: 'preview' } },
    { ssoProtection: null },
    { ssoProtection: { deploymentType: 'all' }, protectionBypass: { secret: { scope: 'automation-bypass' } } },
  ]) {
    const calls = [];
    const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({
      id: 'prj_abcdef1234', name: 'small-site', framework: null, ...project,
    }) }; };
    await assert.rejects(deployReviewedPreview({ ...inputs, fetchImpl }), /All Deployments protection/);
    assert.deepEqual(calls.map(call => call.options.method ?? 'GET'), ['GET']);
  }
});

test('unexpected Production target preserves a bounded deployment identity for inspection', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return { ok: true, json: async () => ({ id: 'dpl_production123',
      url: 'small-site-prod.vercel.app', target: 'production', readyState: 'READY', secret: 'must-not-leak' }) };
    if (url.includes('/v7/deployments')) return { ok: true, json: async () => ({ deployments: [
      { id: 'dpl_existing123', projectId: 'prj_abcdef1234', target: 'production', state: 'READY' },
    ] }) };
    return { ok: true, json: async () => ({ id: 'prj_abcdef1234', name: 'small-site', framework: null,
      ssoProtection: { deploymentType: 'all' } }) };
  };
  const error = await deployReviewedPreview({ ...inputs, fetchImpl }).then(() => null, value => value);
  assert.ok(error instanceof UnsafeVercelDeploymentError);
  assert.deepEqual(error.receipt, { team: 'small-team', project: 'small-site', projectId: 'prj_abcdef1234',
    deploymentId: 'dpl_production123', url: 'https://small-site-prod.vercel.app', target: 'production',
    state: 'READY', artifactSha256: artifactDigest('<h1>Reviewed</h1>', 'h1{color:teal}') });
  assert.ok(!JSON.stringify(error.receipt).includes('must-not-leak'));
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
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

test('a project with inherited custom commands or output paths is rejected before upload', async () => {
  for (const setting of ['rootDirectory', 'buildCommand', 'installCommand', 'outputDirectory', 'devCommand', 'commandForIgnoringBuildStep', 'ignoreCommand', 'link']) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ id: 'prj_abcdef1234', name: 'small-site', framework: null, [setting]: 'echo unsafe' }) };
    };
    await assert.rejects(deployReviewedPreview({ ...inputs, fetchImpl }), /no Git link or custom build settings/);
    assert.equal(calls.length, 1);
  }
});

test('Vercel errors and credential absence do not expose response or token', async () => {
  await assert.rejects(deployReviewedPreview({ ...inputs, token: '' }), /token missing/);
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'secret response body' });
  const error = await deployReviewedPreview({ ...inputs, fetchImpl }).then(() => null, value => value);
  assert.match(error.message, /Vercel request failed \(401\)/);
  assert.doesNotMatch(error.message, /secret|fake-test-token/);
});

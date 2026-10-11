import test from 'node:test';
import assert from 'node:assert/strict';
import { renderArtifact } from '../lib/static-site.mjs';
import { createHostedPublisher } from '../lib/hosted-publish.mjs';
import { UnsafeVercelDeploymentError, deployReviewedPreview, verifyDeletedVercelAttempt } from '../lib/publish-vercel.mjs';
import { createHostedMayaHandler } from '../api/maya-projects.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const site = renderArtifact({ title: 'Garden Club', theme: 'forest', sections: [
  { type: 'hero', heading: 'Grow together', body: 'A garden club for neighbors.', actionText: 'Explore' },
  { type: 'text', heading: 'Join us', body: 'Meet your neighbors and learn to grow vegetables.' },
] });
const env = { OFFICE_ALLOWED_ORIGINS: 'https://office.example', OFFICE_RUN_ALLOWED_EMAILS: 'owner@example.com',
  VILLAGE_PUBLISH_GITHUB_TOKEN: 'mock-github-token', VILLAGE_PUBLISH_GITHUB_OWNER: 'alice',
  VILLAGE_PUBLISH_GITHUB_REPO: 'smoke-site', VILLAGE_PUBLISH_GITHUB_BRANCH: 'village-publish',
  VILLAGE_PUBLISH_GITHUB_DEDICATED_REPO_CONFIRMED: 'true',
  VILLAGE_PUBLISH_VERCEL_TOKEN: 'mock-vercel-token', VILLAGE_PUBLISH_VERCEL_TEAM: 'small-team',
  VILLAGE_PUBLISH_VERCEL_PROJECT: 'smoke-site' };
const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, sub: 'owner-sub', email: 'owner@example.com' }
  : cookie === 'other' ? { status: 200, sub: 'other-sub', email: 'owner@example.com' }
    : cookie === 'viewer' ? { status: 200, sub: 'viewer-sub', email: 'viewer@example.com' } : { status: 401 } };

function fixture({ status = 'reviewed' } = {}) {
  let version = 0;
  let snapshot = { id, status, artifact: { sha256: site.sha256 }, files: { html: site.html, css: site.css },
    events: [{ agent: 'Quinn', type: 'review', reviewedSha256: site.sha256, message: 'Reviewed exact files' }] };
  const access = {
    async read(cookie, projectId) { return cookie === 'owner' && projectId === id ? { id, version, snapshot: structuredClone(snapshot) } : null; },
    async update(cookie, { id: projectId, expectedVersion, snapshot: next }) {
      if (cookie !== 'owner' || projectId !== id || version !== expectedVersion) return null;
      snapshot = structuredClone(next); version++; return { id, version, snapshot: structuredClone(snapshot) };
    },
  };
  return { access, read: () => structuredClone(snapshot), change: update => { snapshot = update(snapshot); version++; } };
}
function response() { return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } }; }
async function call(handler, cookie, body, origin = 'https://office.example') {
  const result = response();
  await handler({ method: 'POST', url: '/api/maya-projects', body, headers: { host: 'office.example', origin,
    cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }, result);
  return { status: result.statusCode, value: JSON.parse(result.body) };
}

test('hosted publish is owner scoped, same origin, exact reviewed receipt, and server-bound to its target', async () => {
  const { access, read } = fixture();
  const calls = [];
  const publisher = createHostedPublisher({ access, env, githubPublisher: async args => {
    calls.push(args); return { repository: 'alice/smoke-site', branch: 'village-publish', commitSha: 'a'.repeat(40),
      artifactSha256: site.sha256, url: 'https://github.com/alice/smoke-site/tree/village-publish' };
  } });
  const handler = createHostedMayaHandler({ env, auth, publisher, coordinator: {}, enabled: true });
  const fingerprint = (await publisher.status('owner', id)).targets.github.fingerprint;
  const body = { action: 'publishGithub', id, artifactSha256: site.sha256, targetFingerprint: fingerprint };
  assert.equal((await call(handler, 'viewer', body)).status, 403);
  assert.equal((await call(handler, 'other', body)).status, 404);
  assert.equal((await call(handler, 'owner', body, 'https://other.example')).status, 403);
  assert.equal((await call(handler, 'owner', { ...body, owner: 'attacker' })).status, 400);
  assert.equal((await call(handler, 'owner', { ...body, artifactSha256: 'b'.repeat(64) })).status, 400);
  assert.equal(calls.length, 0);
  const first = await call(handler, 'owner', body);
  assert.equal(first.status, 200);
  assert.equal(first.value.receipt.commitSha, 'a'.repeat(40));
  assert.equal(calls[0].owner, 'alice');
  assert.equal(calls[0].repo, 'smoke-site');
  assert.equal(calls[0].token, 'mock-github-token');
  assert.equal(calls[0].snapshot.sha256, site.sha256);
  assert.equal((await call(handler, 'owner', body)).value.receipt.commitSha, 'a'.repeat(40));
  assert.equal(calls.length, 1);
  assert.equal(read().events.at(-1).type, 'publish');
  const status = await call(handler, 'owner', { action: 'publishStatus', id });
  assert.equal(status.value.targets.github.owner, 'alice');
  assert.ok(!JSON.stringify(status.value).includes('mock-github-token'));
});

test('hosted duplicate in flight or interrupted submission cannot create a second external write', async () => {
  const { access, read } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const publisher = createHostedPublisher({ access, env, vercelPublisher: async () => { calls++; started(); await gate;
    return { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef', deploymentId: 'dpl_abcdef',
      url: 'https://smoke-site.vercel.app', state: 'QUEUED', artifactSha256: site.sha256 }; } });
  const fingerprint = (await publisher.status('owner', id)).targets.vercel.fingerprint;
  const first = publisher.publish('owner', id, 'vercel', site.sha256, fingerprint);
  await entered;
  const repeated = await publisher.publish('owner', id, 'vercel', site.sha256, fingerprint);
  assert.equal(repeated.status, 'submitting');
  assert.equal(calls, 1);
  assert.equal(read().events.filter(event => event.type === 'publish').length, 0);
  release();
  assert.equal((await first).status, 'submitted');
  assert.equal((await publisher.publish('owner', id, 'vercel', site.sha256, fingerprint)).status, 'submitted');
  assert.equal(calls, 1);
  assert.equal(read().events.filter(event => event.type === 'publish').length, 1);
});

test('hosted missing configuration and changed reviewed bytes fail before external write', async () => {
  const { access, change } = fixture();
  let calls = 0;
  const publisher = createHostedPublisher({ access, env: { ...env, VILLAGE_PUBLISH_GITHUB_TOKEN: '' }, githubPublisher: async () => { calls++; } });
  const status = await publisher.status('owner', id);
  await assert.rejects(publisher.publish('owner', id, 'github', site.sha256, status.targets.github.fingerprint), /not configured/);
  change(project => ({ ...project, files: { ...project.files, html: project.files.html + 'changed' } }));
  await assert.rejects(publisher.publish('owner', id, 'vercel', site.sha256, status.targets.vercel.fingerprint), /Reviewed artifact receipt required/);
  assert.equal(calls, 0);
});

test('a destination changed after status is shown is rejected before any claim or external write', async () => {
  const { access, read } = fixture();
  const settings = { ...env };
  let calls = 0;
  const publisher = createHostedPublisher({ access, env: settings, githubPublisher: async args => { calls++;
    assert.equal(args.repo, 'other-site');
    return { repository: 'alice/other-site', branch: 'village-publish', commitSha: 'c'.repeat(40),
      artifactSha256: site.sha256, url: 'https://github.com/alice/other-site/tree/village-publish' };
  } });
  const displayed = (await publisher.status('owner', id)).targets.github.fingerprint;
  settings.VILLAGE_PUBLISH_GITHUB_REPO = 'other-site';
  await assert.rejects(publisher.publish('owner', id, 'github', site.sha256, displayed), /Publish target changed; refresh status/);
  assert.equal(calls, 0);
  assert.equal(read().publishing, undefined);
  const fresh = (await publisher.status('owner', id)).targets.github.fingerprint;
  assert.notEqual(fresh, displayed);
  assert.equal((await publisher.publish('owner', id, 'github', site.sha256, fresh)).status, 'submitted');
  assert.equal(calls, 1);
});

test('proven preflight failures release the durable claim; uncertain external results do not', async () => {
  for (const service of ['github', 'vercel']) {
    const { access, read } = fixture();
    let calls = 0;
    const options = { access, env,
      githubPublisher: async () => { calls++; throw new Error('preflight rejected target'); },
      vercelPublisher: async () => { calls++; throw new Error('preflight rejected target'); } };
    const publisher = createHostedPublisher(options);
    const fingerprint = (await publisher.status('owner', id)).targets[service].fingerprint;
    await assert.rejects(publisher.publish('owner', id, service, site.sha256, fingerprint), /setup can be corrected and retried/);
    assert.equal(read().publishing?.[service], undefined);
    assert.equal(read().events.at(-1).type, 'publish_error');
    await assert.rejects(publisher.publish('owner', id, service, site.sha256, fingerprint), /setup can be corrected and retried/);
    assert.equal(calls, 2);
  }
  for (const service of ['github', 'vercel']) {
    const { access, read } = fixture();
    let calls = 0;
    const failAfterAttempt = async options => { calls++;
      await (service === 'github' ? options.onBeforeRefUpdate() : options.onBeforeSubmit());
      throw new Error('external outcome unknown'); };
    const publisher = createHostedPublisher({ access, env, githubPublisher: failAfterAttempt, vercelPublisher: failAfterAttempt });
    const fingerprint = (await publisher.status('owner', id)).targets[service].fingerprint;
    await assert.rejects(publisher.publish('owner', id, service, site.sha256, fingerprint), /external outcome unknown/);
    assert.equal(read().publishing?.[service].status, 'submitting');
    assert.equal((await publisher.publish('owner', id, service, site.sha256, fingerprint)).status, 'submitting');
    assert.equal(calls, 1);
  }
});

test('known unsafe Vercel target is recorded for inspection and never marked published or retried', async () => {
  const { access, read } = fixture();
  let calls = 0;
  const unsafe = { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef1234',
    deploymentId: 'dpl_production123', url: 'https://smoke-site-prod.vercel.app', target: 'production',
    state: 'READY', artifactSha256: site.sha256 };
  const publisher = createHostedPublisher({ access, env, vercelPublisher: async args => {
    calls++;
    await args.onBeforeSubmit();
    throw new UnsafeVercelDeploymentError(unsafe);
  } });
  const fingerprint = (await publisher.status('owner', id)).targets.vercel.fingerprint;
  await assert.rejects(publisher.publish('owner', id, 'vercel', site.sha256, fingerprint), /non-Preview deployment/);
  assert.equal(read().publishing.vercel.status, 'needs_inspection');
  assert.deepEqual(read().publishing.vercel.receipt, unsafe);
  assert.equal(read().events.at(-1).type, 'publish_unsafe');
  assert.equal(read().events.some(event => event.type === 'publish'), false);
  assert.deepEqual((await publisher.status('owner', id)).receipts.vercel.receipt, unsafe);
  assert.equal((await publisher.publish('owner', id, 'vercel', site.sha256, fingerprint)).status, 'needs_inspection');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(read()).includes('mock-vercel-token'));
});

test('deleted uncertain Vercel attempt can be reconciled once against an inert baseline before retry', async () => {
  const { access, read } = fixture();
  const deletedDeploymentId = 'dpl_deleted123';
  const baselineDeploymentId = 'dpl_baseline123';
  let publishes = 0;
  let verified = 0;
  let clock = Date.parse('2026-10-11T22:54:00Z');
  const publisher = createHostedPublisher({ access, env, now: () => clock,
    vercelPublisher: async args => { publishes++; if (publishes === 1) { await args.onBeforeSubmit(); throw new Error('unknown result'); }
      return { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef', deploymentId: 'dpl_preview123',
        url: 'https://smoke-preview.vercel.app', state: 'READY', artifactSha256: site.sha256 }; },
    deletionVerifier: async args => { verified++; assert.equal(args.deletedDeploymentId, deletedDeploymentId);
      assert.equal(args.baselineDeploymentId, baselineDeploymentId); return { projectId: 'prj_abcdef', deletedDeploymentId, baselineDeploymentId }; },
  });
  const fingerprint = (await publisher.status('owner', id)).targets.vercel.fingerprint;
  await assert.rejects(publisher.publish('owner', id, 'vercel', site.sha256, fingerprint), /unknown result/);
  assert.equal(read().publishing.vercel.status, 'submitting');
  const old = (await publisher.status('owner', id)).receipts.vercel;
  clock += 16 * 60_000;
  const handler = createHostedMayaHandler({ env, auth, publisher, coordinator: {}, enabled: true });
  const body = { action: 'reconcileVercel', id, artifactSha256: site.sha256, targetFingerprint: fingerprint,
    deletedDeploymentId, baselineDeploymentId, attemptStartedAt: old.startedAt, attemptId: old.attemptId };
  assert.equal((await call(handler, 'viewer', body)).status, 403);
  assert.equal((await call(handler, 'owner', body, 'https://other.example')).status, 403);
  assert.equal((await call(handler, 'owner', { ...body, extra: 'x' })).status, 400);
  await assert.rejects(publisher.reconcileVercel('other', id, site.sha256, fingerprint, deletedDeploymentId, baselineDeploymentId, old.startedAt, old.attemptId), /Project not found/);
  await assert.rejects(publisher.reconcileVercel('owner', id, site.sha256, 'f'.repeat(64), deletedDeploymentId, baselineDeploymentId, old.startedAt, old.attemptId), /target changed/);
  assert.equal(publishes, 1);
  const http = await call(handler, 'owner', body);
  assert.equal(http.status, 200);
  const result = http.value;
  assert.equal(result.status, 'reconciled');
  assert.equal(verified, 1);
  assert.equal(read().events.at(-1).type, 'publish_reconciled');
  assert.equal((await publisher.reconcileVercel('owner', id, site.sha256, fingerprint, deletedDeploymentId, baselineDeploymentId, old.startedAt, old.attemptId)).status, 'reconciled');
  assert.equal(verified, 1);
  const changed = createHostedPublisher({ access, env: { ...env, VILLAGE_PUBLISH_VERCEL_PROJECT: 'different-site' },
    vercelPublisher: async () => { publishes++; } });
  const changedFingerprint = (await changed.status('owner', id)).targets.vercel.fingerprint;
  await assert.rejects(changed.publish('owner', id, 'vercel', site.sha256, changedFingerprint), /target or reviewed receipt changed/);
  assert.equal(publishes, 1);
  assert.equal((await publisher.publish('owner', id, 'vercel', site.sha256, fingerprint)).status, 'submitted');
  assert.equal(publishes, 2);
  assert.equal((await publisher.publish('owner', id, 'vercel', site.sha256, fingerprint)).status, 'submitted');
  assert.equal(publishes, 2);
  assert.equal(read().events.filter(event => event.type === 'publish_reconciled').length, 1);
});

test('Vercel reconciliation checks protection, complete sole-baseline inventory, and deleted ID', async () => {
  const old = 'dpl_deleted123', baseline = 'dpl_baseline123', projectId = 'prj_abcdef';
  const args = { team: 'small-team', project: 'smoke-site', token: 'mock-vercel-token',
    deletedDeploymentId: old, baselineDeploymentId: baseline };
  let inventory = [{ uid: baseline, projectId, target: 'production', readyState: 'READY' }];
  let bypass = null, oldStatus = 404;
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(url);
    assert.equal(options.headers.authorization, 'Bearer mock-vercel-token');
    if (url.includes('/v9/projects/')) return { ok: true, json: async () => ({ id: projectId, name: 'smoke-site',
      link: null, ssoProtection: { deploymentType: 'all' }, protectionBypass: bypass }) };
    if (url.includes('/v7/deployments')) return { ok: true, json: async () => ({ deployments: inventory, pagination: { count: inventory.length } }) };
    return { status: oldStatus };
  };
  assert.deepEqual(await verifyDeletedVercelAttempt({ ...args, fetchImpl }), { projectId,
    deletedDeploymentId: old, baselineDeploymentId: baseline });
  assert.equal(seen.length, 3);
  inventory = [...inventory, { id: 'dpl_duplicate123', projectId, target: null, readyState: 'READY' }];
  await assert.rejects(verifyDeletedVercelAttempt({ ...args, fetchImpl }), /inventory changed/);
  inventory = inventory.slice(0, 1); oldStatus = 200;
  await assert.rejects(verifyDeletedVercelAttempt({ ...args, fetchImpl }), /not verified deleted/);
  oldStatus = 404; bypass = { unsafe: { scope: 'automation-bypass' } };
  await assert.rejects(verifyDeletedVercelAttempt({ ...args, fetchImpl }), /target changed/);
});

test('reconciled Preview retry rechecks the sole baseline immediately before POST', async () => {
  const calls = [];
  let inventory = [{ uid: 'dpl_baseline123', projectId: 'prj_abcdef', target: 'production', state: 'READY' }];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (url.includes('/v9/projects/')) return { ok: true, json: async () => ({ id: 'prj_abcdef', name: 'smoke-site',
      framework: null, ssoProtection: { deploymentType: 'all' } }) };
    if (url.includes('/v7/deployments') && url.includes('target=production')) return { ok: true, json: async () => ({ deployments: inventory.slice(0, 1) }) };
    if (url.includes('/v7/deployments')) return { ok: true, json: async () => ({ deployments: inventory, pagination: { count: inventory.length } }) };
    return { ok: true, json: async () => ({ id: 'dpl_preview123', url: 'smoke-preview.vercel.app', target: null, readyState: 'READY' }) };
  };
  const inputs = { engine: { get: async () => ({ status: 'reviewed', artifact: { sha256: site.sha256 } }),
    artifact: async (_id, file) => file === 'index.html' ? site.html : site.css }, id, team: 'small-team', project: 'smoke-site',
    token: 'mock-vercel-token', fetchImpl, expectedSoleBaselineId: 'dpl_baseline123' };
  inventory = [...inventory, { uid: 'dpl_duplicate123', projectId: 'prj_abcdef', target: null, state: 'READY' }];
  await assert.rejects(deployReviewedPreview(inputs), /inventory changed/);
  assert.equal(calls.some(call => call.method === 'POST'), false);
  inventory = inventory.slice(0, 1);
  assert.equal((await deployReviewedPreview(inputs)).deploymentId, 'dpl_preview123');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('failed reconciled preflight retains baseline constraint on every later retry', async () => {
  const { access, read } = fixture();
  let attempts = 0, externalWrites = 0, inventorySafe = false;
  let clock = Date.parse('2026-10-11T22:54:00Z');
  const publisher = createHostedPublisher({ access, env, now: () => clock,
    deletionVerifier: async () => ({ projectId: 'prj_abcdef', deletedDeploymentId: 'dpl_deleted123', baselineDeploymentId: 'dpl_baseline123' }),
    vercelPublisher: async args => {
      attempts++;
      if (attempts === 1) { await args.onBeforeSubmit(); throw new Error('unknown result'); }
      assert.equal(args.expectedSoleBaselineId, 'dpl_baseline123');
      if (!inventorySafe) throw new Error('Vercel deployment inventory changed; manual inspection required');
      await args.onBeforeSubmit(); externalWrites++;
      return { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef', deploymentId: 'dpl_preview123',
        url: 'https://smoke-preview.vercel.app', state: 'READY', artifactSha256: site.sha256 };
    },
  });
  const fingerprint = (await publisher.status('owner', id)).targets.vercel.fingerprint;
  await assert.rejects(publisher.publish('owner', id, 'vercel', site.sha256, fingerprint), /unknown result/);
  const old = (await publisher.status('owner', id)).receipts.vercel;
  clock += 16 * 60_000;
  await publisher.reconcileVercel('owner', id, site.sha256, fingerprint, 'dpl_deleted123', 'dpl_baseline123', old.startedAt, old.attemptId);
  await assert.rejects(publisher.publish('owner', id, 'vercel', site.sha256, fingerprint), /setup can be corrected and retried/);
  assert.equal(read().publishing.vercel.status, 'reconciled');
  assert.equal(externalWrites, 0);
  await assert.rejects(publisher.publish('owner', id, 'vercel', site.sha256, fingerprint), /setup can be corrected and retried/);
  assert.equal(read().publishing.vercel.status, 'reconciled');
  assert.equal(externalWrites, 0);
  inventorySafe = true;
  assert.equal((await publisher.publish('owner', id, 'vercel', site.sha256, fingerprint)).status, 'submitted');
  assert.equal(externalWrites, 1);
});

test('a fresh in-flight claim cannot be reconciled, and stale recovery cannot reopen the next attempt', async () => {
  const { access, read } = fixture();
  let clock = Date.parse('2026-10-11T22:54:00Z');
  let enterFirst, releaseFirst, enterSecond, releaseSecond, writes = 0, verifies = 0;
  const firstEntered = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondEntered = new Promise(resolve => { enterSecond = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  const publisher = createHostedPublisher({ access, env, now: () => clock,
    deletionVerifier: async () => { verifies++; return { projectId: 'prj_abcdef', deletedDeploymentId: 'dpl_deleted123', baselineDeploymentId: 'dpl_baseline123' }; },
    vercelPublisher: async args => {
      if (writes === 0) { enterFirst(); await firstGate; await args.onBeforeSubmit(); writes++; throw new Error('old uncertain result'); }
      enterSecond(); await secondGate; await args.onBeforeSubmit(); writes++;
      return { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef', deploymentId: 'dpl_preview123',
        url: 'https://smoke-preview.vercel.app', state: 'READY', artifactSha256: site.sha256 };
    },
  });
  const fingerprint = (await publisher.status('owner', id)).targets.vercel.fingerprint;
  const first = publisher.publish('owner', id, 'vercel', site.sha256, fingerprint);
  await firstEntered;
  const old = (await publisher.status('owner', id)).receipts.vercel;
  assert.equal(old.status, 'submitting');
  assert.ok(old.startedAt);
  assert.ok(old.attemptId);
  const handler = createHostedMayaHandler({ env, auth, publisher, coordinator: {}, enabled: true });
  const staleBody = { action: 'reconcileVercel', id, artifactSha256: site.sha256, targetFingerprint: fingerprint,
    deletedDeploymentId: 'dpl_deleted123', baselineDeploymentId: 'dpl_baseline123',
    attemptStartedAt: old.startedAt, attemptId: old.attemptId };
  const activeResponse = await call(handler, 'owner', staleBody);
  assert.equal(activeResponse.status, 409);
  assert.match(activeResponse.value.error, /may still be active/);
  await assert.rejects(publisher.reconcileVercel('owner', id, site.sha256, fingerprint,
    'dpl_deleted123', 'dpl_baseline123', old.startedAt, old.attemptId), /may still be active/);
  assert.equal(verifies, 0);
  releaseFirst();
  await assert.rejects(first, /old uncertain result/);
  clock += 16 * 60_000;
  await publisher.reconcileVercel('owner', id, site.sha256, fingerprint,
    'dpl_deleted123', 'dpl_baseline123', old.startedAt, old.attemptId);
  const second = publisher.publish('owner', id, 'vercel', site.sha256, fingerprint);
  await secondEntered;
  const next = (await publisher.status('owner', id)).receipts.vercel;
  assert.notEqual(next.attemptId, old.attemptId);
  const staleResponse = await call(handler, 'owner', staleBody);
  assert.equal(staleResponse.status, 409);
  assert.match(staleResponse.value.error, /attempt changed/);
  await assert.rejects(publisher.reconcileVercel('owner', id, site.sha256, fingerprint,
    'dpl_deleted123', 'dpl_baseline123', old.startedAt, old.attemptId), /attempt changed/);
  assert.equal(verifies, 1);
  releaseSecond();
  assert.equal((await second).status, 'submitted');
  assert.equal(writes, 2);
  assert.equal(read().events.filter(event => event.type === 'publish_reconciled').length, 1);
});

test('recovery during a delayed old preflight fences its POST after a new attempt starts', async () => {
  const { access, read } = fixture();
  let clock = Date.parse('2026-10-11T22:54:00Z');
  let entered, release, calls = 0, posts = 0;
  const gateEntered = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const publisher = createHostedPublisher({ access, env, now: () => clock,
    deletionVerifier: async () => ({ projectId: 'prj_abcdef', deletedDeploymentId: 'dpl_deleted123', baselineDeploymentId: 'dpl_baseline123' }),
    vercelPublisher: async args => {
      calls++;
      if (calls === 1) { entered(); await gate; }
      await args.onBeforeSubmit(); posts++;
      return { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef', deploymentId: 'dpl_preview123',
        url: 'https://smoke-preview.vercel.app', state: 'READY', artifactSha256: site.sha256 };
    },
  });
  const fingerprint = (await publisher.status('owner', id)).targets.vercel.fingerprint;
  const oldRun = publisher.publish('owner', id, 'vercel', site.sha256, fingerprint);
  await gateEntered;
  const old = (await publisher.status('owner', id)).receipts.vercel;
  clock += 16 * 60_000; // simulate an attempt past the function execution bound
  await publisher.reconcileVercel('owner', id, site.sha256, fingerprint,
    'dpl_deleted123', 'dpl_baseline123', old.startedAt, old.attemptId);
  assert.equal((await publisher.publish('owner', id, 'vercel', site.sha256, fingerprint)).status, 'submitted');
  release();
  await assert.rejects(oldRun, /claim changed/);
  assert.equal(posts, 1);
  assert.equal(read().publishing.vercel.status, 'submitted');
});

test('a late result from an older attempt cannot overwrite a newer durable claim', async () => {
  const { access, read, change } = fixture();
  let entered, release;
  const gateEntered = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const publisher = createHostedPublisher({ access, env, vercelPublisher: async args => {
    await args.onBeforeSubmit(); entered(); await gate;
    return { team: 'small-team', project: 'smoke-site', projectId: 'prj_abcdef', deploymentId: 'dpl_oldpreview123',
      url: 'https://old-preview.vercel.app', state: 'READY', artifactSha256: site.sha256 };
  } });
  const fingerprint = (await publisher.status('owner', id)).targets.vercel.fingerprint;
  const oldRun = publisher.publish('owner', id, 'vercel', site.sha256, fingerprint);
  await gateEntered;
  change(snapshot => { const next = structuredClone(snapshot); next.publishing.vercel = { ...next.publishing.vercel,
    attemptId: 'new-attempt', startedAt: '2026-10-11T23:30:00.000Z' }; return next; });
  release();
  await assert.rejects(oldRun, /receipt changed/);
  assert.equal(read().publishing.vercel.attemptId, 'new-attempt');
  assert.equal(read().events.some(event => event.type === 'publish'), false);
});

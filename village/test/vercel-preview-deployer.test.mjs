import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VercelCliClient, VercelPreviewDeployer } from '../vercel-preview-deployer.mjs';

const projectId = 'prj_1234567890abcdef';
const teamId = 'team_1234567890abcdef';
const previewUrl = 'https://astra-lab-preview-abc-jmanns-projects.vercel.app';
const baseMission = {
  id: 'mission-preview-1', repo: 'startupsandcode/agent-village', artifactId: 'artifact-preview-1',
  previewTarget: { provider: 'vercel', projectId, teamId, environment: 'preview',
    projectSlug: 'astra-lab', teamSlug: 'jmanns-projects' },
  mayaAgreement: { acceptedByUser: true, previewTarget: { provider: 'vercel', projectId, teamId,
    environment: 'preview', projectSlug: 'astra-lab', teamSlug: 'jmanns-projects' } },
};

async function fixture(t, { mission = baseMission, targetOverride, cliOverride } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'village-vercel-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const artifactRoot = join(workspaceRoot, 'dist');
  const stateRoot = join(root, 'state');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(artifactRoot, 'index.html'), `<html><head><meta name="village-artifact-id" content="${mission.artifactId}"></head><body>Preview</body></html>`);
  const calls = [];
  const cli = cliOverride ?? {
    async whoami() { calls.push({ kind: 'whoami' }); return 'test-user'; },
    async deploy(options) {
      const outputConfig = await readFile(join(options.artifactPath, '.vercel', 'output', 'config.json'), 'utf8');
      const linkedProject = JSON.parse(await readFile(join(options.artifactPath, '.vercel', 'project.json'), 'utf8'));
      const staticFiles = await import('node:fs/promises').then(({ readdir }) => readdir(join(options.artifactPath, '.vercel', 'output', 'static')));
      calls.push({ kind: 'deploy', options, outputConfig, linkedProject, staticFiles });
      return { id: 'dpl_1234567890abcdef', url: previewUrl };
    },
    async inspect(id) {
      calls.push({ kind: 'inspect', id });
      const deployMeta = calls.find(call => call.kind === 'deploy')?.options.meta;
      return { id: 'dpl_1234567890abcdef', url: previewUrl, projectId, target: 'preview', readyState: 'READY', meta: deployMeta };
    },
  };
  const target = targetOverride ?? mission.previewTarget;
  const deployer = new VercelPreviewDeployer({ workspaceRoot, stateRoot, targets: [target], cli });
  return { root, workspaceRoot, artifactRoot, stateRoot, mission, calls, deployer, target };
}

test('submits only an accepted preview deployment to the exact allowlisted project and team', async t => {
  const f = await fixture(t);
  const result = await f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });

  assert.equal(result.status, 'ready');
  assert.equal(result.url, previewUrl);
  assert.equal(result.target, 'preview');
  assert.equal(f.calls.filter(call => call.kind === 'deploy').length, 1);
  const deployment = f.calls.find(call => call.kind === 'deploy');
  assert.equal(deployment.options.target, 'preview');
  assert.equal(deployment.options.prebuilt, true);
  assert.equal(deployment.options.projectId, projectId);
  assert.equal(deployment.options.teamId, teamId);
  assert.equal(deployment.outputConfig, '{"version":3}\n');
  assert.deepEqual(deployment.linkedProject, { projectId, orgId: teamId });
  assert.deepEqual(deployment.staticFiles, ['index.html']);
});

test('rejects production and any project/team/hostname outside the explicit allowlist before submission', async t => {
  const f = await fixture(t);
  const productionMission = { ...f.mission, previewTarget: { ...f.mission.previewTarget, environment: 'production' },
    mayaAgreement: { ...f.mission.mayaAgreement, previewTarget: { ...f.mission.previewTarget, environment: 'production' } } };
  await assert.rejects(f.deployer.deploy({ mission: productionMission, artifactRoot: f.artifactRoot }), /preview-only/);

  const otherTargetMission = { ...f.mission, previewTarget: { ...f.mission.previewTarget, projectId: 'prj_9876543210abcdef' },
    mayaAgreement: { ...f.mission.mayaAgreement, previewTarget: { ...f.mission.previewTarget, projectId: 'prj_9876543210abcdef' } } };
  await assert.rejects(f.deployer.deploy({ mission: otherTargetMission, artifactRoot: f.artifactRoot }), /not allowlisted/);

  const badSuffixMission = { ...f.mission,
    previewTarget: { ...f.mission.previewTarget, teamSlug: 'other-team' },
    mayaAgreement: { ...f.mission.mayaAgreement, previewTarget: { ...f.mission.previewTarget, teamSlug: 'other-team' } } };
  await assert.rejects(f.deployer.deploy({ mission: badSuffixMission, artifactRoot: f.artifactRoot }), /not allowlisted/);
  assert.equal(f.calls.length, 0);
});

test('low-level Vercel CLI client refuses production and non-prebuilt deploy requests', async () => {
  const cli = new VercelCliClient();
  const base = { artifactPath: 'C:/artifact', projectId, teamId, target: 'preview', prebuilt: true,
    meta: { villageMissionId: 'mission-preview-1', villageArtifactId: 'artifact-preview-1', villageArtifactSha256: 'a'.repeat(64) } };
  await assert.rejects(cli.deploy({ ...base, target: 'production' }), /preview-only and prebuilt-only/);
  await assert.rejects(cli.deploy({ ...base, prebuilt: false }), /preview-only and prebuilt-only/);
});

test('computes and sends a stable fingerprint for the exact staged artifact and marker', async t => {
  const f = await fixture(t);
  const result = await f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });
  const metadata = f.calls.find(call => call.kind === 'deploy').options.meta;
  assert.match(result.artifactFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(metadata.villageMissionId, f.mission.id);
  assert.equal(metadata.villageArtifactId, f.mission.artifactId);
  assert.equal(metadata.villageArtifactSha256, result.artifactFingerprint);
  assert.equal(f.calls.find(call => call.kind === 'deploy').options.artifactFingerprint, result.artifactFingerprint);
});

test('rejects artifacts outside the mission workspace and missing exact artifact marker', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'index.html'), '<html>wrong</html>');
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: outside }), /inside the approved workspace/);
  await writeFile(join(f.artifactRoot, 'index.html'), '<html>wrong artifact</html>');
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /artifact marker/);
  assert.equal(f.calls.length, 0);
});

test('uploads only static build output and excludes package manifests and environment files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.artifactRoot, '.env'), 'SECRET=must-not-upload');
  await writeFile(join(f.artifactRoot, 'package.json'), '{"scripts":{"build":"echo must-not-run"}}');
  await f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });
  const deployment = f.calls.find(call => call.kind === 'deploy');
  assert.deepEqual(deployment.staticFiles, ['index.html']);
  assert.equal(deployment.options.prebuilt, true);
});

test('honors cancellation before preview submission without calling Vercel', async t => {
  const f = await fixture(t);
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot,
    isCancelled: async () => true }), /cancelled before submission/);
  assert.equal(f.calls.length, 0);
});

test('requires the pre-existing Vercel CLI login before writing a submission checkpoint', async t => {
  const f = await fixture(t, { cliOverride: {
    async whoami() { throw new Error('existing Vercel CLI login unavailable'); },
    async deploy() { assert.fail('deployment must not start without the existing login'); },
    async inspect() { assert.fail('inspection is not expected'); },
  } });
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /existing Vercel CLI login unavailable/);
  await assert.rejects(readFile(join(f.stateRoot, `${f.mission.id}.json`), 'utf8'), { code: 'ENOENT' });
});

test('cancellation after submission stops polling and preserves an uncertain checkpoint without retrying', async t => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot,
    isCancelled: async () => ++checks >= 4 }), /uncertain.*reconcile/i);
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /uncertain.*reconcile/i);
  assert.equal(f.calls.filter(call => call.kind === 'deploy').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'inspect').length, 0);
});

test('returns the durable result for a duplicate identical execution without a second deployment', async t => {
  const f = await fixture(t);
  const first = await f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });
  const second = await f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });
  assert.deepEqual(second, first);
  assert.equal(f.calls.filter(call => call.kind === 'deploy').length, 1);
});

test('rejects content changes for a mission identity that already submitted its artifact', async t => {
  const f = await fixture(t);
  await f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });
  await writeFile(join(f.artifactRoot, 'index.html'), `<html><head><meta name="village-artifact-id" content="${f.mission.artifactId}"></head><body>Changed</body></html>`);
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /identity changed after submission/);
  assert.equal(f.calls.filter(call => call.kind === 'deploy').length, 1);
});

test('retries once only when the CLI proves no deployment submission started', async t => {
  let submissions = 0;
  let fFingerprint;
  const f = await fixture(t, { cliOverride: {
    async whoami() { return 'test-user'; },
    async deploy(options) {
      submissions++;
      if (submissions === 1) { const error = new Error('CLI could not start'); error.submitted = false; throw error; }
      fFingerprint = options.meta.villageArtifactSha256;
      return { id: 'dpl_1234567890abcdef', url: previewUrl };
    },
    async inspect(id) {
      const deployMeta = { villageMissionId: fMission.id, villageArtifactId: fMission.artifactId,
        villageArtifactSha256: fFingerprint };
      return { id, url: previewUrl, projectId, target: 'preview', readyState: 'READY', meta: deployMeta };
    },
  } });
  const fMission = f.mission;
  const firstAttempt = f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });
  await assert.rejects(firstAttempt, /CLI could not start/);
  const result = await f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot });
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 2);
  assert.equal(submissions, 2);
});

test('fails closed after an uncertain deployment submission and never retries it automatically', async t => {
  let submissions = 0;
  const f = await fixture(t, { cliOverride: {
    async whoami() { return 'test-user'; },
    async deploy() {
      submissions++;
      const error = new Error('connection closed after request submission');
      error.submitted = true;
      throw error;
    },
    async inspect() { throw new Error('must not inspect without a deployment ID'); },
  } });

  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /uncertain.*reconcile/i);
  await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /uncertain.*reconcile/i);
  assert.equal(submissions, 1);
  const journal = JSON.parse(await readFile(join(f.stateRoot, `${f.mission.id}.json`), 'utf8'));
  assert.equal(journal.status, 'uncertain');
});

test('rejects successful submission if Vercel reports production, a different project, or an unapproved host', async t => {
  for (const invalid of [
    { target: 'production', projectId, url: previewUrl },
    { target: 'preview', projectId: 'prj_other', url: previewUrl },
    { target: 'preview', projectId, url: 'https://evil.example.org' },
    { target: 'preview', projectId, url: `${previewUrl}/unapproved-path` },
  ]) {
    const f = await fixture(t, { cliOverride: {
      async whoami() { return 'test-user'; },
      async deploy() { return { id: 'dpl_1234567890abcdef', url: previewUrl }; },
      async inspect() { return { id: 'dpl_1234567890abcdef', url: invalid.url, projectId: invalid.projectId,
        target: invalid.target, readyState: 'READY', meta: {
          villageMissionId: fMission.id, villageArtifactId: fMission.artifactId,
          villageArtifactSha256: 'f'.repeat(64),
        } }; },
    } });
    const fMission = f.mission;
    await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /uncertain.*reconcile/i);
    const journal = JSON.parse(await readFile(join(f.stateRoot, `${f.mission.id}.json`), 'utf8'));
    assert.notEqual(journal.status, 'ready');
    await assert.rejects(f.deployer.deploy({ mission: f.mission, artifactRoot: f.artifactRoot }), /reconcile/i);
  }
});

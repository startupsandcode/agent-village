import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createOfficeServer } from '../server.mjs';
import { createMissionLoader } from '../lib/missions.mjs';

const mission = {
  id: 'office-mission-46', goal: 'Build an elegant preview for the approved campaign.', status: 'accepted_preview',
  currentStage: 'susie_visual', createdAt: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T11:00:00.000Z',
  events: [{ stage: 'susie_visual', status: 'done', rendered: { previewUrl: 'https://preview.example.test' },
    output: { guide: 'private stage payload must not be returned' } }],
};

test('local Office missions endpoint exposes a minimal read-only status and verified preview projection', async t => {
  const getMissions = createMissionLoader({ store: { async list() { return [mission]; } },
    now: () => Date.parse('2026-10-24T12:00:00.000Z') });
  const server = createOfficeServer({ getMissions });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/missions`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, { status: 'ok', updatedAt: '2026-10-24T12:00:00.000Z', items: [{
    id: 'office-mission-46', goal: 'Build an elegant preview for the approved campaign.',
    status: 'accepted_preview', currentStage: 'susie_visual', createdAt: mission.createdAt,
    updatedAt: mission.updatedAt, terminal: true, previewUrl: 'https://preview.example.test',
  }] });
  assert.equal(JSON.stringify(body).includes('private stage payload'), false);
  assert.equal((await fetch(`${base}/api/missions`, { method: 'POST' })).status, 405);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const probe = request(`${base}/api/missions`, { headers: { Host: 'attacker.example' } }, result => {
      result.resume();
      result.on('end', () => resolve(result.statusCode));
    });
    probe.on('error', reject);
    probe.end();
  });
  assert.equal(hostileHostStatus, 403);
});

test('local Office mission loader uses the same mission store and reports unavailable on corrupt data', async () => {
  const loader = createMissionLoader({ store: { async list() { throw new Error('private path detail'); } } });
  await assert.rejects(loader(), /private path detail/);
});

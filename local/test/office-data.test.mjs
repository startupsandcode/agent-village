import test from 'node:test';
import assert from 'node:assert/strict';
import { officeData } from '../public/office-data.mjs';

test('office desk activity comes from the current stage, not a past event', () => {
  const project = { status: 'reviewing', events: [
    { agent: 'Maya', type: 'question', message: 'Who is it for?', at: '2026-10-11T10:00:00Z' },
    { agent: 'Maya', type: 'plan', message: 'Plan approved', at: '2026-10-11T10:01:00Z' },
    { agent: 'Sam', type: 'result', message: 'Wrote files', at: '2026-10-11T10:02:00Z' },
    { agent: 'Quinn', type: 'start', message: 'Reviewing SHA-256 abc', at: '2026-10-11T10:03:00Z' },
  ] };
  const view = officeData(project);
  assert.equal(view.activeCount, 1);
  assert.equal(view.agents.find(agent => agent.name === 'Quinn').status, 'working');
  assert.equal(view.agents.find(agent => agent.name === 'Sam').status, 'reported');
  assert.equal(view.agents.find(agent => agent.name === 'Theo').status, 'idle');
  assert.deepEqual(view.tasks.map(task => task.status), ['done', 'done', 'done', 'working']);
  project.status = 'cancelled';
  assert.equal(officeData(project).activeCount, 0);
  assert.equal(officeData(project).tasks[3].status, 'cancelled');
  project.events.push({ agent: 'Quinn', type: 'review', message: 'Previously approved', reviewedSha256: 'abc', at: '2026-10-11T10:04:00Z' });
  project.status = 'blocked'; project.artifact = null;
  assert.equal(officeData(project).tasks[3].status, 'blocked');
});

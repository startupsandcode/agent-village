import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedBudget } from '../lib/hosted-budget.mjs';

function fakeTransactions() {
  const usage = new Map(); const claims = new Set(); const calls = [];
  const transaction = async callback => callback(async (sql, values) => {
    calls.push({ sql, values });
    const [owner, month] = values;
    const key = `${owner}:${month}`;
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (sql.startsWith('SELECT 1 FROM village_budget_claims')) return { rows: claims.has(`${key}:${values[2]}`) ? [{}] : [] };
    if (sql.startsWith('INSERT INTO village_monthly_budget')) { if (!usage.has(key)) usage.set(key, { projects: 0, calls: 0, reservedMicros: 0 }); return { rows: [] }; }
    if (sql.startsWith('UPDATE village_monthly_budget')) {
      const row = usage.get(key);
      if (row.projects + values[2] > values[5] || row.calls + values[3] > values[6] || row.reservedMicros + values[4] > values[7]) return { rows: [] };
      row.projects += values[2]; row.calls += values[3]; row.reservedMicros += values[4]; return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO village_budget_claims')) { claims.add(`${key}:${values[2]}`); return { rows: [] }; }
    throw new Error('Unexpected SQL');
  });
  return { transaction, usage, calls };
}

test('transactional budget deduplicates claims and enforces project, call and spend ceilings', async () => {
  const db = fakeTransactions();
  const auth = { authorize: cookie => cookie === 'owner' ? { status: 200, sub: 'owner-sub' } : cookie === 'other' ? { status: 200, sub: 'other-sub' } : { status: 401 } };
  const budget = createHostedBudget({ transaction: db.transaction, auth });
  const base = { month: '2026-10', maxProjects: 1, maxCalls: 1, maxReservedMicros: 1_000_000, reservedMicros: 0 };
  assert.equal(await budget.reserve('owner', { ...base, id: 'request-123', kind: 'project' }), true);
  assert.equal(await budget.reserve('owner', { ...base, id: 'request-123', kind: 'project' }), true);
  assert.equal(await budget.reserve('owner', { ...base, id: 'request-456', kind: 'project' }), false);
  assert.equal(await budget.reserve('owner', { ...base, id: 'project-123', kind: 'build', reservedMicros: 1_000_000 }), true);
  assert.equal(await budget.reserve('owner', { ...base, id: 'project-123', kind: 'build', reservedMicros: 1_000_000 }), true);
  assert.equal(await budget.reserve('owner', { ...base, id: 'project-456', kind: 'review', reservedMicros: 1_000_000 }), false);
  assert.equal(await budget.reserve('other', { ...base, id: 'request-123', kind: 'project' }), true);
  assert.equal(await budget.reserve('other', { ...base, id: 'project-123', kind: 'build', maxCalls: 2, reservedMicros: 1_000_000 }), true);
  assert.equal(await budget.reserve('other', { ...base, id: 'project-456', kind: 'review', maxCalls: 2, reservedMicros: 1_000_000 }), false);
  assert.equal(db.usage.get('owner-sub:2026-10').projects, 1);
  assert.equal(db.usage.get('owner-sub:2026-10').calls, 1);
  assert.ok(db.calls.every(call => !call.sql.includes('owner-sub')));
  await assert.rejects(budget.reserve('viewer', { ...base, id: 'request-123', kind: 'project' }), /access denied/);
});

// Requires a real database transaction. The owner/month advisory lock serializes claims.
export function createHostedBudget({ transaction, auth }) {
  if (typeof transaction !== 'function' || typeof auth?.authorize !== 'function') throw new Error('Transactional budget and auth required');
  return {
    async reserve(cookie, { id, kind, month, maxProjects, maxCalls, maxReservedMicros, reservedMicros }) {
      const access = auth.authorize(cookie);
      if (access.status !== 200 || !access.sub) throw new Error('Office access denied');
      if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || !/^[A-Za-z0-9_-]{8,80}$/.test(id) || !['project', 'clarify', 'answer', 'build', 'review'].includes(kind)) throw new Error('Invalid budget claim');
      if (![maxProjects, maxCalls, maxReservedMicros, reservedMicros].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid budget limit');
      const sub = access.sub;
      return transaction(async query => {
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`village:${sub}:${month}`]);
        const claimId = `${kind}:${id}`;
        const existing = await query('SELECT 1 FROM village_budget_claims WHERE owner_sub = $1 AND month = $2 AND claim_id = $3', [sub, month, claimId]);
        if (existing.rows.length) return true;
        await query(`INSERT INTO village_monthly_budget (owner_sub, month) VALUES ($1, $2)
          ON CONFLICT (owner_sub, month) DO NOTHING`, [sub, month]);
        const changed = await query(`UPDATE village_monthly_budget SET
          projects = projects + $3, calls = calls + $4, reserved_micros = reserved_micros + $5
          WHERE owner_sub = $1 AND month = $2 AND projects + $3 <= $6
          AND calls + $4 <= $7 AND reserved_micros + $5 <= $8
          RETURNING projects`, [sub, month, kind === 'project' ? 1 : 0, kind === 'project' ? 0 : 1, reservedMicros, maxProjects, maxCalls, maxReservedMicros]);
        if (!changed.rows.length) return false;
        await query(`INSERT INTO village_budget_claims (owner_sub, month, claim_id, kind, reserved_micros)
          VALUES ($1, $2, $3, $4, $5)`, [sub, month, claimId, kind, reservedMicros]);
        return true;
      });
    },
  };
}

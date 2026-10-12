// Owner-scoped persistence boundary. The runtime supplies a parameterized query function.
// `query` is an injected parameterized Postgres query(text, values) function.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
// PostgreSQL jsonb::text adds whitespace; leave ample room below the SQL check.
const MAX_SNAPSHOT_BYTES = 131_072;
const DASHBOARD_PAGE_SIZE = 25;

function owner(value) {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error('Verified owner required');
  return value;
}
function projectId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid project ID');
  return value;
}
function snapshotJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project snapshot');
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) throw new Error('Project snapshot too large');
  return json;
}
function record(row) {
  if (!row) return null;
  return { id: row.id, version: Number(row.version), snapshot: typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot };
}

export function createHostedProjectStore({ query }) {
  if (typeof query !== 'function') throw new Error('Parameterized database query required');
  return {
    async list({ ownerSub, offset = 0 }) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('Invalid project offset');
      const rows = await query(`SELECT id, version, updated_at, snapshot->>'goal' AS goal,
        snapshot->>'status' AS status, snapshot->>'createdAt' AS created_at,
        snapshot->'plan'->>'summary' AS plan_summary,
        snapshot->'events'->-1->>'agent' AS latest_agent,
        snapshot->'events'->-1->>'message' AS latest_message,
        snapshot->'events'->-1->>'at' AS latest_at
        FROM village_projects WHERE owner_sub = $1
        ORDER BY CASE
          WHEN snapshot->>'status' IN ('clarifying', 'planning', 'building', 'reviewing', 'needs_answer', 'ready', 'awaiting_review') THEN 0
          WHEN snapshot->>'status' IN ('question_error', 'blocked', 'interrupted') THEN 1
          ELSE 2 END, updated_at DESC, id DESC
        LIMIT $2 OFFSET $3`, [owner(ownerSub), DASHBOARD_PAGE_SIZE + 1, offset]);
      const hasMore = rows.rows.length > DASHBOARD_PAGE_SIZE;
      return { projects: rows.rows.slice(0, DASHBOARD_PAGE_SIZE).map(row => ({
        id: row.id, version: Number(row.version), goal: row.goal, status: row.status,
        createdAt: row.created_at, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        planSummary: row.plan_summary, latestAgent: row.latest_agent, latestMessage: row.latest_message, latestAt: row.latest_at,
      })), hasMore, nextOffset: hasMore ? offset + DASHBOARD_PAGE_SIZE : null };
    },
    async recentStages({ ownerSub, since }) {
      if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) throw new Error('Invalid activity cutoff');
      const result = await query(`SELECT DISTINCT ON (snapshot->>'status') id, snapshot->>'goal' AS goal,
        snapshot->>'status' AS status, snapshot->>'stageStartedAt' AS stage_started_at
        FROM village_projects WHERE owner_sub = $1
        AND snapshot->>'status' IN ('clarifying', 'planning', 'building', 'reviewing')
        AND snapshot->>'stageStartedAt' >= $2
        ORDER BY snapshot->>'status', snapshot->>'stageStartedAt' DESC`, [owner(ownerSub), since]);
      return result.rows.map(row => ({ id: row.id, goal: row.goal, status: row.status, stageStartedAt: row.stage_started_at }));
    },
    async create({ ownerSub, id, requestId, snapshot }) {
      const sub = owner(ownerSub);
      projectId(id);
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error('Invalid request ID');
      const encoded = snapshotJson(snapshot);
      const inserted = await query(`INSERT INTO village_projects (owner_sub, id, create_request_id, snapshot)
        VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING
        RETURNING id, version, snapshot`, [sub, id, requestId, encoded]);
      if (inserted.rows[0]) return record(inserted.rows[0]);
      // A retry returns the existing request for this owner; another owner's row is never read.
      const existing = await query(`SELECT id, version, snapshot FROM village_projects
        WHERE owner_sub = $1 AND create_request_id = $2`, [sub, requestId]);
      if (!existing.rows[0]) throw new Error('Project ID conflict');
      return record(existing.rows[0]);
    },
    async read({ ownerSub, id }) {
      const rows = await query(`SELECT id, version, snapshot FROM village_projects
        WHERE owner_sub = $1 AND id = $2`, [owner(ownerSub), projectId(id)]);
      return record(rows.rows[0]);
    },
    async update({ ownerSub, id, expectedVersion, snapshot }) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid project version');
      const encoded = snapshotJson(snapshot);
      const rows = await query(`UPDATE village_projects SET snapshot = $4::jsonb,
        version = version + 1, updated_at = now()
        WHERE owner_sub = $1 AND id = $2 AND version = $3
        RETURNING id, version, snapshot`, [owner(ownerSub), projectId(id), expectedVersion, encoded]);
      return record(rows.rows[0]); // null means cancellation, a concurrent update, or an unseen project
    },
  };
}

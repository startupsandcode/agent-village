// Owner-scoped persistence boundary. The runtime supplies a parameterized query function.
// `query` is an injected parameterized Postgres query(text, values) function.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
// PostgreSQL jsonb::text adds whitespace; leave ample room below the SQL check.
const MAX_SNAPSHOT_BYTES = 131_072;

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

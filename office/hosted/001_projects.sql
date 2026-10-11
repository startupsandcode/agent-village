-- Run on a dedicated database/role before enabling hosted Maya writes.
-- The application always supplies owner_sub from the verified office session.
CREATE TABLE IF NOT EXISTS village_projects (
  owner_sub text NOT NULL,
  id uuid NOT NULL,
  create_request_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_sub, id),
  UNIQUE (owner_sub, create_request_id),
  CONSTRAINT village_owner_length CHECK (length(owner_sub) BETWEEN 1 AND 200),
  CONSTRAINT village_request_length CHECK (length(create_request_id) BETWEEN 8 AND 80),
  CONSTRAINT village_snapshot_size CHECK (octet_length(snapshot::text) <= 262144)
);

CREATE INDEX IF NOT EXISTS village_projects_owner_recent
  ON village_projects (owner_sub, updated_at DESC);

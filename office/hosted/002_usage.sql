-- Additive migration after 001_projects.sql. Run before enabling hosted Maya
-- with this release. A pending row is an attempted call with unknown usage,
-- never a charge estimate. Owner and call identity prevent duplicate counts.
CREATE TABLE IF NOT EXISTS village_provider_usage (
  owner_sub text NOT NULL,
  call_id text NOT NULL,
  project_id uuid NOT NULL,
  agent text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  month char(7) NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  cache_creation_input_tokens bigint,
  estimated_cost_nano_usd bigint,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (owner_sub, call_id),
  CONSTRAINT village_usage_owner_length CHECK (length(owner_sub) BETWEEN 1 AND 200),
  CONSTRAINT village_usage_call_length CHECK (length(call_id) BETWEEN 1 AND 150),
  CONSTRAINT village_usage_state CHECK (state IN ('pending', 'measured', 'unreported')),
  CONSTRAINT village_usage_nonnegative CHECK (
    (input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (cached_input_tokens IS NULL OR cached_input_tokens >= 0)
    AND (cache_creation_input_tokens IS NULL OR cache_creation_input_tokens >= 0)
    AND (estimated_cost_nano_usd IS NULL OR estimated_cost_nano_usd >= 0))
);
CREATE INDEX IF NOT EXISTS village_provider_usage_owner_month
  ON village_provider_usage (owner_sub, month, started_at DESC);
CREATE INDEX IF NOT EXISTS village_provider_usage_owner_project
  ON village_provider_usage (owner_sub, project_id, started_at DESC);

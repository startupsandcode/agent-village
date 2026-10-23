-- Additive owner-scoped setup for the hosted domain interview.
-- Run after 001_projects.sql and before deploying the hosted interview runtime.
CREATE TABLE IF NOT EXISTS village_domain_profiles (
  owner_sub text PRIMARY KEY,
  profile jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT village_domain_owner_length CHECK (length(owner_sub) BETWEEN 1 AND 200),
  CONSTRAINT village_domain_profile_size CHECK (octet_length(profile::text) <= 4096)
);

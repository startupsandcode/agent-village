# Hosted usage migration

`002_usage.sql` is an additive migration for the dedicated Agent Village Preview database. It creates `village_provider_usage` and two indexes. It has no `DROP`, `DELETE`, or changes to the three `001_projects.sql` tables. The current hosted runtime continues to work before this migration; apply it before deploying the usage-tracking runtime.

1. Open the SQL editor for the database referenced by Preview's server-side `VILLAGE_DATABASE_URL`. Check the database and branch names before running SQL. Do not paste the connection string or API keys into chat or the website.
2. Run the complete contents of [`002_usage.sql`](002_usage.sql) once in the same schema where `001_projects.sql` created its tables. `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` make an exact retry safe.
3. Confirm the `village_provider_usage` table exists. With the **application database role** used by `VILLAGE_DATABASE_URL`, verify `SELECT 1 FROM village_provider_usage LIMIT 1` succeeds. If the migration was run under a different database role, grant that application role `SELECT`, `INSERT`, and `UPDATE` on `village_provider_usage`; `DELETE` is not needed. The migration's schema owner must also permit index creation at migration time.
4. Once the usage runtime is deployed, sign in as an allowed Preview operator and open `/api/maya-health` on that exact Preview. `usageReady: true` verifies the application role can read this table. It does not verify writes or a live model call. A paid test needs a separate user-supplied provider key and spending limit.

The table is scoped by verified OAuth `owner_sub`; each provider attempt has a stable call ID. Pending or unreported token counts are unknown, not zero-cost claims. Provider billing remains the source of truth for charges.

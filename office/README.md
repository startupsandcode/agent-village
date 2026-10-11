# Hosted Agent Village office

The Vercel `agent-village` project uses `office` as its Root Directory. It serves the [synthetic demo](https://agent-village.startupsandcode.com/) at `/` and the invited office at `/office`. `/api/office` is also private. Project-wide Vercel Authentication is disabled; the application enforces office access. The old `agent-village-demo` project has been deleted.

An anonymous visit to `/office` shows a minimal sign-in page. The viewer must choose **Sign in with Vercel** to start OAuth. **Sign out of office** clears the office session and returns to the demo; returning to `/office` shows the sign-in page even if the viewer is still signed in to Vercel. An uninvited account receives an access-denied response.

## Sign in with Vercel app

In Vercel Team Settings → Apps, create an app with confidential `client_secret_post` authentication. Register both exact callback URLs: `https://agent-village-six.vercel.app/api/auth/callback` and `https://agent-village.startupsandcode.com/api/auth/callback`. The server selects the callback from the registered production host. Enable only the `openid` and `email` scopes; the office does not request Vercel API permissions or offline access. A viewer must have a Vercel account and an email address on the office invite list.

Set these **server-only** environment variables in the existing project for Production (and for Preview if you will use a separately registered callback there):

| Variable | Value |
| --- | --- |
| `VERCEL_APP_CLIENT_ID` | ID shown on the Vercel app's Manage page |
| `VERCEL_APP_CLIENT_SECRET` | The generated confidential client secret |
| `OFFICE_SESSION_SECRET` | Independently generated random signing secret, at least 32 bytes; changing it signs everyone out |
| `OFFICE_ALLOWED_EMAILS` | Comma-separated, exact invited email addresses; compared without case on every private request |
| `GITHUB_AGENT_TOKEN` | Existing server-only GitHub token with Issues read access (`GITHUB_ISSUES_TOKEN` takes precedence when set) |

Do not prefix these variable names with `NEXT_PUBLIC_`, and do not place values in source files or `public/`. Redeploy after changing environment variables. A missing value denies access. Sign-in on unregistered Preview hosts fails closed. Register a preview callback and deliberately adapt the server configuration before testing a preview sign-in.

## Production access checks

After the cutover on 2026-09-18, anonymous GET and HEAD requests to `/` returned the public demo. Anonymous GET `/office` returned only the sign-in page, while HEAD `/office` returned no body. Anonymous GET and HEAD `/api/office` returned 401 without private issue data. The former demo URL returned 404 after its Vercel project was deleted.

When changing OAuth settings, invite emails, or access code, repeat those checks from a clean browser session. Sign in with an invited account and confirm `/office` and `/api/office` load the workboard; an uninvited account must be denied. Check that public assets and responses contain no GitHub token or OAuth secrets.

The hosted desks still say that live check-ins are not connected. Local check-in files do not persist to Vercel.
For the **local** office issue board, set `VILLAGE_GITHUB_REPO` to the repository you intend to read before `node office/server.mjs`; without it the board is unavailable. The local server uses your existing `gh` login only for that explicitly selected repository.

## A cloned office

Set `OFFICE_ALLOWED_ORIGINS` to a comma-separated list of **exact HTTPS origins** for your own Vercel host and custom domain, and register `<origin>/api/auth/callback` in your own confidential Vercel OAuth app. When this variable is set, John's default hosts are no longer allowed. Set `OFFICE_ALLOWED_EMAILS` to your own invited email list and generate your own `OFFICE_SESSION_SECRET`. Set `VILLAGE_GITHUB_REPO=your-owner/your-repo` and give the server a credential limited to reading that repository's issues. A cloned hosted office with its own origins but no repository setting shows an unavailable board; it does not fall back to John's issues. `office/.env.example` contains variable names and placeholders; enter real values only in your Vercel project's server-side secret settings. Do not copy John's OAuth app, allowlist, provider key, or issue token. If the issue credential is absent or does not match the repository, the board reports unavailable rather than showing another repository's tasks.

`/api/maya-status` uses the same office session guard as `/api/office`. It reports only whether a provider key is present, without returning or validating the key. The hosted Maya run remains disabled because this repository has not connected private durable project storage or a hosted coordinator. A user can use the local interface described in `local/README.md` now; setting a Vercel secret alone does not make a hosted run work.

The private office shows setup status for viewer sign-in, provider key, durable project storage, future code execution, GitHub publishing and Vercel publishing. Viewer sign-in can show as connected; a provider key can only show as present and unverified. The others remain unavailable regardless of token-like environment variables because no guarded write routes exist. The first hosted artifact remains a static website rendered without executing model-written code; Vercel Sandbox is needed only for broader code tasks. The migration in `hosted/001_projects.sql` and adapter in `lib/hosted-project-store.mjs` model transactional Postgres rows keyed by the verified Vercel OAuth `sub` for state, idempotency keys, event receipts and exact artifact bytes. `lib/hosted-project-access.mjs` binds every operation to the verified session. These pieces are tested with an in-memory fake query, not connected to a live database or HTTP route. A future hosted coordinator must enforce call/time budgets, stage-specific idempotency, cancellation, and receipt verification before turning on chat/build. GitHub and Vercel publication require separate scoped authorization and an explicit target confirmation; the viewer's `openid email` session is not publishing permission. No hosted project, repository or deployment is created by this PR.

### Minimal hosted setup proposal

The existing `jmanns-projects/agent-village` Vercel project already has Root Directory `office/`, Node 24, and the private viewer OAuth flow. Read-only integration inspection on 2026-10-11 found no connected storage resource. Keep this project. Add one Vercel Marketplace Neon Postgres database, scoped to this project, then apply `hosted/001_projects.sql` with a database role permitted only on the Village tables. No Redis, Blob store, or Sandbox is needed for the bounded static-site path. The app's future database adapter should use the Neon serverless driver and parameterized queries; this repository does not yet install the driver or open a connection.

Use `VILLAGE_DATABASE_URL` for the database connection in **server-only Production** settings, and in Preview only after a separate protected preview database and callback are chosen. Keep the existing `VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, `OFFICE_SESSION_SECRET`, `OFFICE_ALLOWED_EMAILS`, and exact `OFFICE_ALLOWED_ORIGINS` server-only. Choose either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` with `VILLAGE_PROVIDER`; a provider key is billed separately and should be project restricted and spend limited. Do not put any of these in `public/`, browser storage, chat, logs, or Git. No new GitHub/Vercel publishing token is proposed: their current identity checks grant no write rights, and publication needs a later user-scoped authorization flow.

For a small pilot, cap hosted runs at 20 projects per month per office and four provider calls per project before connecting the route. At the current 1,800 output-token and 32,768-byte input limits per call, 20 projects can emit at most 144,000 output tokens and send at most 2.62 million input bytes. Using [Anthropic's published Sonnet 5.5 rates](https://www.anthropic.com/claude-sonnet-5-5) of $10 per million output tokens and $2 per million input tokens, this is roughly $7 in model usage if input tokens are no more numerous than input bytes. Provider overhead, retries, database usage, Vercel Functions, and any other workloads add cost and need separate limits. Set a provider spend cap and Vercel spend management below the $300 monthly total budget before a paid test. These are planning estimates, not observed charges or a guarantee; no paid run occurred here.

## Web Analytics

Vercel Web Analytics is enabled in the `agent-village` project. The tracking script is included only on the public synthetic demo at `/`; the private office HTML has no analytics script. View page visits in the project's [Analytics dashboard](https://vercel.com/jmanns-projects/agent-village/analytics). Local development may fail to load the Vercel-only script, but the demo still works.

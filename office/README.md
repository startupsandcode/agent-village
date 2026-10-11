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

`/api/maya-status` uses the same office session guard as `/api/office`. It reports provider configuration without returning a key. The hosted Maya run remains disabled because this repository has not connected private durable project storage or an isolated job executor. A user can use the local interface described in `local/README.md` now; setting a Vercel secret alone does not make a hosted run work.

## Web Analytics

Vercel Web Analytics is enabled in the `agent-village` project. The tracking script is included only on the public synthetic demo at `/`; the private office HTML has no analytics script. View page visits in the project's [Analytics dashboard](https://vercel.com/jmanns-projects/agent-village/analytics). Local development may fail to load the Vercel-only script, but the demo still works.

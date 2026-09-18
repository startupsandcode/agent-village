# Hosted Agent Village office

The existing Vercel `agent-village` project uses `office` as its Root Directory. It serves the synthetic demo at `/` and the invited office at `/office`. `/api/office` is also private. The old `agent-village-demo` project remains available during migration and can be removed after the new public and private paths have been verified in production.

## Sign in with Vercel app

In Vercel Team Settings → Apps, create an app with confidential `client_secret_post` authentication. Register the exact callback URL `https://agent-village-six.vercel.app/api/auth/callback`. Enable only the `openid` and `email` scopes; the office does not request Vercel API permissions or offline access. A viewer must have a Vercel account and an email address on the office invite list.

Set these **server-only** environment variables in the existing project for Production (and for Preview if you will use a separately registered callback there):

| Variable | Value |
| --- | --- |
| `VERCEL_APP_CLIENT_ID` | ID shown on the Vercel app's Manage page |
| `VERCEL_APP_CLIENT_SECRET` | The generated confidential client secret |
| `OFFICE_SESSION_SECRET` | Independently generated random signing secret, at least 32 bytes; changing it signs everyone out |
| `OFFICE_ALLOWED_EMAILS` | Comma-separated, exact invited email addresses; compared without case on every private request |
| `GITHUB_AGENT_TOKEN` | Existing server-only GitHub token with Issues read access (`GITHUB_ISSUES_TOKEN` takes precedence when set) |

Do not prefix these variable names with `NEXT_PUBLIC_`, and do not place values in source files or `public/`. Redeploy after changing environment variables. A missing value denies access. The OAuth callback is fixed to the production URL, so a Preview sign-in returns to Production. Register a preview callback and deliberately adapt the server configuration before testing a preview sign-in.

## Release sequence

1. Keep Vercel Authentication set to **All Deployments** while deploying the new code and secrets to `agent-village`.
2. In the protected production deployment, check that the demo loads at `/`, that `/demo-data.json` is synthetic, and that a signed-in invited account reaches `/office` and loads `/api/office`.
3. Confirm denied responses from the app-level guards for anonymous and uninvited sessions before turning off project-wide Vercel Authentication. Check both `/office` and `/api/office` with GET and HEAD.
4. After switching protection off, repeat the anonymous and invited checks from a clean browser session. Confirm the GitHub token and OAuth secrets are absent from public assets and API responses.
5. Remove the old `agent-village-demo` project only after the single project's public and private paths pass production checks. Old demo-domain links will then stop working.

The hosted desks still say that live check-ins are not connected. Local check-in files do not persist to Vercel.

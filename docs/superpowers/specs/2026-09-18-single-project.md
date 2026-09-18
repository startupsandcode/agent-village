# Single Agent Village project

Issue: https://github.com/startupsandcode/agent-village/issues/15

The existing `agent-village` Vercel project will serve the synthetic demo at `/` and the invited live office at `/office`. The separate `agent-village-demo` project stays online until the replacement is verified in production.

## Access

- The public page and `/demo-data.json` use synthetic data only.
- `/office` and `/api/office` require a valid server-issued session created after Sign in with Vercel.
- The callback checks Vercel User Info for a verified email and compares it with the server-only `OFFICE_ALLOWED_EMAILS` list. A Vercel account alone is insufficient.
- The API checks the session and current allowlist before requesting GitHub data. The office page is served by a guarded function, not from public static files.
- OAuth client secret, session signing secret, allowed emails, and GitHub token are server-only Vercel environment variables. No secret is embedded in demo assets.
- OAuth uses authorization code with PKCE S256, state, nonce, a fixed callback URL, secure HttpOnly SameSite cookies, and a short session expiry. Errors fail closed.

## Migration

1. Add combined routes, code, tests, and setup documentation on issue #15's branch.
2. Register a Vercel OAuth app with callback `https://agent-village-six.vercel.app/api/auth/callback`, configure its secret and allowed email in the existing project, and test sign-in while project-wide protection still shields the deployment.
3. Open the public landing page only after confirming anonymous requests to `/office` and `/api/office` are denied by the app itself. Test invited and uninvited accounts.
4. Delete `agent-village-demo` after the single project serves both experiences and the private boundary is verified. Existing demo-domain links may stop working after deletion.

## Acceptance checks

- Anonymous `/` returns the demo; anonymous `/office` and `/api/office` reveal no private information.
- Invited sign-in reaches the live office and its server-side GitHub issue data; uninvited sign-in is denied.
- OAuth state, nonce, callback, cookies, and session tampering have meaningful tests.
- The browser bundle contains no private token or auth secret.

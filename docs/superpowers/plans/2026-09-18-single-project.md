# Single Agent Village Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the public synthetic demo and invited live office from the existing Agent Village Vercel project.

**Architecture:** Copy demo assets into the `office` deployment root, move the live office HTML outside `public`, and serve it through an authenticated function at `/office`. Use Vercel OAuth for identity, a server-only invite list, and a signed HttpOnly session cookie. Guard `/api/office` before the GitHub loader runs.

**Tech Stack:** Node.js 24, Vercel Functions, static HTML/CSS/JS, Node built-in test runner and crypto.

**Spec:** `docs/superpowers/specs/2026-09-18-single-project.md`

## Global Constraints

- Preserve the existing `agent-village` project and `GITHUB_AGENT_TOKEN` server environment variable.
- Do not disable current Vercel Authentication or remove the demo project until the new auth boundary is tested in production.
- Use the Vercel OAuth endpoints and PKCE S256 described in the official Sign in with Vercel documentation.
- Protect both `/office` and `/api/office` independently. Check the current invite list on every private request.
- Keep generated assets and server secrets separate; fail closed when config is missing.

---

### Task 1: Identity and session boundary

**Files:** Create `office/lib/auth.mjs`; create `office/test/auth.test.mjs`.

**Interfaces:** Export helpers to start the OAuth flow, validate the callback, issue/verify a signed session, parse cookies, and authorize an email against `OFFICE_ALLOWED_EMAILS`. Use request/response primitives compatible with Vercel Node functions.

- [ ] Write tests for missing configuration, verified invited email, unverified or uninvited email, expired/tampered session, and invalid OAuth state/nonce.
- [ ] Run `node --test office/test/auth.test.mjs` and confirm the new tests fail for missing behavior.
- [ ] Implement with Node crypto (`randomBytes`, SHA-256, HMAC and timing-safe comparison) and User Info from Vercel's authenticated endpoint.
- [ ] Re-run the targeted tests, then `node --test office/test/*.test.mjs`.

### Task 2: Authenticated routes

**Files:** Create `office/api/auth/login.mjs`, `office/api/auth/callback.mjs`, `office/api/auth/logout.mjs`, and `office/api/private-page.mjs`; modify `office/api/office.mjs`; add route tests under `office/test/`.

**Interfaces:** `/api/auth/login` starts code flow; `/api/auth/callback` validates state and identity then sets the session; `/api/auth/logout` clears it; `/office` rewrites to `private-page`; `/api/office` returns 401 or 403 before `getTasks()` without an authorized session.

- [ ] Write failing route tests for anonymous, invited, uninvited, and misconfigured states. Assert no GitHub fetch on denied API requests.
- [ ] Implement functions and enforce GET/HEAD method handling with no-store responses and safe redirects.
- [ ] Run targeted route tests, then all `office/test` tests.

### Task 3: One deployment's public and private assets

**Files:** Modify `office/vercel.json`, `office/public/`, and `demo/public/` only as needed; add an asset/routing test.

**Interfaces:** Public `/` and `/demo-data.json` render synthetic content; private HTML is outside `office/public`; its asset paths resolve under `/office/`; public assets contain no API secret or live issue payload.

- [ ] Write a failing check for expected public and private file layout and routes.
- [ ] Move/copy assets, update links, and configure the `/office` rewrite.
- [ ] Run route/layout checks, `node --test office/test/*.test.mjs`, and `git diff --check`.

### Task 4: Release and cutover

**Files:** Document setup in `office/README.md` or the existing deployment guide; update code only for bugs found in verification.

- [ ] Document OAuth app callback, `VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, `OFFICE_SESSION_SECRET`, `OFFICE_ALLOWED_EMAILS`, and GitHub token setup.
- [ ] Open PR linked to issue #15 and obtain an independent review of security-sensitive changes.
- [ ] Confirm Vercel preview builds; configure credentials in the existing project without exposing values in git or client assets.
- [ ] Verify production in protected mode, then switch project-wide protection only after `/office` and `/api/office` deny anonymous and uninvited requests.
- [ ] Verify public `/`, invited `/office`, private API, and synthetic-data boundary, then remove the demo project.

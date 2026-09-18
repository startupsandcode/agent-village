# Village Office on Vercel

## Release boundary

Use two Vercel projects from this repository. The public project has root directory `demo` and contains only synthetic, static content. The private project has root directory `office` and uses Vercel Authentication with **All Deployments** protection before any GitHub credential is configured or a deployment is shared. Vercel project protection applies to the entire private deployment, including `/api/office`.

This release serves John's single private Agent Village repository. It does not provide customer accounts, tenant separation, or a public API for real issue data. Those need a separate product design.

## Private data flow

The office browser fetches only `/api/office`. A Node.js Vercel Function reads `GITHUB_ISSUES_TOKEN` from the server environment and requests open issues from `startupsandcode/agent-village`. It filters pull requests and returns only issue number, title, URL, and update time. The token is never serialized, logged, or placed in a public asset. Failed or missing credentials produce an unavailable task state without echoing errors.

The local server and CLI check-in flow remain available for local use. Hosted desk reports are explicitly unavailable until a durable report store and authenticated write path are designed. This avoids pretending that local files are shared with Vercel or that an open issue proves an agent is active.

## Credential choice

Use a fine-grained personal access token restricted to the single `agent-village` repository, with **Issues: Read-only** and GitHub's required Metadata read permission. No Contents, Pull requests, or write permission is required for the issue board. Store it as a Secret project environment variable named `GITHUB_ISSUES_TOKEN` in the private Vercel project only. Do not put it in the public demo project or a file in this repository. A GitHub App can replace the token when there are multiple repositories, customers, or an operational need for short-lived installation tokens.

## Release checks

Before creating the Vercel credential, verify private project Deployment Protection is set to Vercel Authentication, All Deployments. Verify unauthenticated requests to both `/` and `/api/office` are blocked. Then configure the token, deploy, and verify that the browser bundle and API response contain no token, the authorized issue board loads, and GitHub errors reveal no secret. The public demo must contain only synthetic data and make no request to the private API.

# Village Office deployment design

## Current deployment

The `agent-village` Vercel project uses `office/` as its root directory. One project serves the public synthetic demo at `/`, the public design-led workflow explainer at `/workflow`, the public setup guide at `/setup`, and the invited workspace at `/office`. The obsolete `agent-village-demo` project is no longer part of the deployment.

Vercel project-wide Authentication is disabled so the public pages remain reachable. Private routes enforce access in the application: `/office` is served by a guarded function, and private APIs such as `/api/office` authorize a signed office session before returning data. Authentication uses the configured Vercel OAuth app and an exact invited-email list. Missing or invalid authentication configuration fails closed. The current route behavior and setup requirements are documented in [the hosted office guide](../office/README.md).

## Data boundaries

The public demo and workflow pages use static, synthetic content. They do not expose the private issue board. The private issue API reads GitHub Issues server-side using a server-only token and returns selected issue fields; credentials are not sent to browser code. Hosted project activity is available only to an authenticated owner when its database is configured. Local desk check-ins and local mission records remain on the local machine and are not synchronized to the hosted office.

## Operational limits

The hosted office is a single-owner workspace, not a multi-tenant service. A signed-in viewer is not automatically authorized to incur provider charges or publish externally. Hosted runs and publishing require separately configured server-side credentials, explicit operator authorization, bounded destinations, and durable receipts. Static demo content and preview deployments do not prove that a hosted run or publishing integration is enabled.

Do not rely on Vercel project-wide protection to secure the private office: public and private routes share one deployment. Keep authorization checks on every private page and API route, and verify anonymous denial plus invited and uninvited account behavior after changes. See [the hosted office guide](../office/README.md) for the maintained operational checklist.

## Future architecture

Supporting multiple organizations, projects, or independently coordinated teams requires a separate design for tenant isolation, per-owner data stores, credential scope, budgets, and deployment boundaries. The current single-project application does not provide those guarantees.

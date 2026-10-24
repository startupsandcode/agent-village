# Design-led bounded missions

This milestone can start one design-led mission in `startupsandcode/agent-village` from a clean named feature branch. It asks Maya to return an agreed scope, summary, and testable criteria. The CLI presents that proposal and requires one exact user acceptance before it creates the durable mission. If Maya flags an unresolved scope, access, budget, or destructive-action question, the CLI stops before creating a mission.

After that single agreement, stage adapters call the installed Codex CLI in this order:

1. Susie returns a structured guide with concept, hierarchy, typography, spacing, responsive states, imagery and interactions.
2. Sam receives that persisted guide and the agreed acceptance criteria. His CLI run uses the workspace-write sandbox with automatic approval review; it cannot publish, merge, provision resources, or add credentials.
3. Quinn receives the agreed criteria and Sam's preview candidate in a read-only run.
4. Playwright opens the exact approved URL in Chromium, blocks requests to other origins, checks the rendered artifact marker, title, heading, fonts, image alt attributes and horizontal overflow at desktop and narrow sizes, and captures screenshots.
5. Susie receives both real screenshots in a read-only visual-review run. A bounded revision returns to Sam, then repeats Quinn and Susie review.

The append-only journal stores Maya's accepted scope, design-guide data, stage outputs, attempts, review feedback, browser evidence and final state. A single-use local lock rejects duplicate runs. Cancellation is checked at stage boundaries. The CLI caps each stage at two attempts and the visual revision loop at one; input files cannot raise those limits. Retryable errors may resume only within the attempt limit; uncertain writes and stale locks fail closed for manual reconciliation.

## Start a mission

Install the project browser dependency with `npm ci --prefix village` and install the matching Chromium binary with `npm exec --prefix village -- playwright install chromium`. Create a JSON input file containing a unique mission `id`, `goal`, an already-authorized `destination` URL, `artifactId`, and any additional `constraints`. Do not include secrets. Start the existing local preview server for that destination before the worker begins. The preview HTML must contain `<meta name="village-artifact-id" content="YOUR_ARTIFACT_ID">` so the browser can bind its screenshots to the requested artifact.

Set `VILLAGE_MISSION_WORKSPACE` to the root of a clean `startupsandcode/agent-village` checkout on a named feature branch. The CLI adds fixed no-production, no-paid-resources, no-new-credentials, and ownership constraints. It caps a mission at fifteen Codex role calls including Maya intake, two attempts per stage and one visual revision. Then run:

```powershell
node village/mission-cli.mjs start .\mission-input.json
```

The default durable state and evidence directories are `~/.agent-village/missions` and `~/.agent-village/evidence`; override them with `VILLAGE_MISSION_ROOT` and `VILLAGE_MISSION_EVIDENCE_ROOT`. `show <id>` reads status, `cancel <id>` requests cancellation, and `resume <id>` continues from a confirmed safe checkpoint. The workspace must stay available while the synchronous CLI command runs.

## Verification boundary

The test suite includes real Chromium against an ephemeral local HTTP preview and a full CLI integration test with mock role outputs. It verifies that the browser, exact destination, artifact marker, screenshots, screenshot digests and desktop/narrow states work together. Unit tests also exercise role order, Maya agreement, guide enforcement, failure/retry, cancellation, duplicate execution and uncertain-write handling. The Codex role adapter uses the real CLI contract, schemas and permissions, but this task did not launch a live role: a live `codex exec` can consume the account's existing Codex quota, and no paid agent run was authorized.

This worker does not deploy or publish. Sam must return a URL that already serves the accepted artifact at the exact approved destination; otherwise browser review blocks. There is no automatic deployment integration, completion notification hook, or unattended scheduler. A local mission run remains active only while the user's machine and CLI process are running. Crash recovery detects in-flight uncertainty but does not replay that stage automatically.

## Future portfolio manager

The per-mission manifest and handler configuration are isolated so a later portfolio manager can coordinate multiple teams. That layer still needs project lists and priorities, one team/workspace per project, dependency coordination, shared budget and concurrency limits, and collision handling for repositories, branches, artifacts and preview destinations. This milestone starts only one mission and does not add those shared services.


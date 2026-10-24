# Design-led local missions

`village/mission-runner.mjs` provides a local orchestration primitive for one approved mission in `startupsandcode/agent-village`. It records a versioned manifest as a synced append-only JSONL journal and coordinates the assigned handlers in this order:

1. Susie writes the design guide.
2. Sam implements the guide.
3. Quinn checks functional evidence.
4. Susie reviews the rendered result.
5. If Susie requests a revision, the runner returns to Sam and repeats the functional and visual reviews, up to the mission's configured revision limit.

The manifest pins the approved goal, constraints, repository, preview destination, artifact identity, team ID, role map, attempt limits, revision count, status and event evidence. A local exclusive lock rejects concurrent runs. The runner honors cancellation at stage boundaries and gives each stage a bounded attempt count. Only errors explicitly marked `retryable` are retried automatically; this avoids replaying a stage after an uncertain write. Any existing lock fails closed. After a crash during a stage, an operator must confirm the old process exited before removing the stale lock. The in-flight checkpoint then becomes blocked; this milestone has no reconciliation API, so it cannot automatically resume uncertain work.

The visual-review handler must return a preview URL, the exact pinned artifact and destination, desktop and narrow viewport evidence references, and a screenshot reference. `MissionRunner` also requires an injected `verifyRenderedEvidence` implementation to confirm those values before recording the visual result. A mission cannot reach `accepted_preview` without this verification, plus Susie design, Sam implementation and Quinn functional evidence.

## Current boundary

This module is an orchestration and persistence primitive, not a hosted runner. `MissionStore.create` accepts caller-supplied mission input; this milestone has no intake/UI path that records or enforces Maya's initial agreement before creation. It does not launch Codex roles, create a design guide, run a browser, capture screenshots, provide an artifact destination, or deploy a preview. The local site renderer and `verifyStaticSite` check generated HTML/CSS structure and safety; they do not render a browser viewport or capture visual evidence. Chrome and Edge executables are installed on this host, but this checkout has no Playwright/Puppeteer dependency or browser automation adapter wired to the mission process. A file-only Chrome screenshot probe failed under the default sandbox and worked only after elevated execution; the runner cannot invoke that elevated tool path as an unattended adapter. The chat's interactive browser tool is not callable from this Node process. The repository also has no role-launch adapter for these four stages (the existing worker targets Astra Lab and supports Maya/Sam/Quinn only).

There is an existing manual path in `local/publish-vercel.mjs` for uploading reviewed static files to an existing configured Vercel project, with safety preflights. It is not connected to this runner, and no mission-specific destination or budget authorization was established here, so it was not invoked.

Therefore, the real mission cannot reach tested-preview acceptance in this milestone: an already-authorized destination, role adapter, browser renderer/screenshot capture, and verifier bound to the exact artifact/destination are still required. The tests use a synthetic verifier solely to exercise the fail-closed acceptance gate. No production release, paid resource, or new credential is part of this milestone.

The JSONL journal supports process-crash detection and safe continuation from confirmed stage checkpoints; it is not an unattended scheduler or background service. No completion-notification hook is implemented. A future local or hosted runner would need an explicitly scoped invocation/scheduler and a notification target already authorized by the user before it can deliver hands-off completion updates.

## Future portfolio manager

Keep this mission model isolated per manifest so a future portfolio manager can create multiple team instances without shared mutable singleton state. That later layer needs explicit project lists and priorities, one team and workspace per project, cross-team dependency coordination, shared budget and concurrency limits, and collision handling for repositories, branches, artifacts and preview destinations. This milestone does not start multiple teams or coordinate projects.


# Agent Village

This repository is a Codex workspace for turning GitHub Issues into reviewed work. GitHub Issues is the durable ticket queue. VS Code with Codex is the primary place to discuss, plan, implement, and review work.

## Working agreement

- Start with the issue's intended outcome and acceptance criteria. If either is unclear, clarify or improve the issue before implementation.
- Keep one issue linked to each branch and pull request. Summarize what changed, how it was verified, and any remaining risk in the pull request.
- Use the smallest set of agents that helps the task. Coordinate their work in the main Codex conversation and keep a single accountable owner for the result.
- The project scoped agents in `.codex/agents/` are specialists: Maya for scope and coordination, Theo for architecture, Sam for implementation, Quinn for independent review, and Susie for product design. Use them when their distinct perspective will change the work; do not invoke every agent by default.
- Agents report evidence from the tools and files they actually inspected. Do not claim a ticket is complete, tests pass, or a PR is ready without verifying it.
- Keep code changes on a feature branch. Open a pull request for review before merging.

## Issue flow

1. Capture the request in a GitHub Issue using `.github/ISSUE_TEMPLATE/work-item.md`.
2. Refine the outcome and acceptance criteria until the issue is ready for work.
3. Implement on a branch, verify the result, and open a PR that links the issue.
4. Review the PR against the issue. Close the issue when the accepted work is merged.

No background worker or automatic issue assignment is configured. Start work from Codex in VS Code by giving it an issue number.

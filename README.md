# Agent Village

Agent Village is a repo based workflow for managing software work with Codex. GitHub Issues holds the ticket queue; Codex in VS Code is the working surface. The main Codex conversation coordinates specialized agents for architecture, implementation, review, and product design when a task benefits from them.

The GitHub Issues and Codex workflow requires no running service, webhook, Vercel deployment, or API keys. The earlier Next.js proof of concept remains in the repo for now, but its Telegram endpoint has been removed.

## Start here

1. Open this repository in VS Code with the Codex extension.
2. Connect to GitHub for issue and pull request work. If you use the GitHub CLI, sign in with `gh auth login`.
3. Describe a piece of work to Codex and ask it to draft a GitHub Issue from the [work item template](.github/ISSUE_TEMPLATE/work-item.md).
4. Once the issue is ready, ask Codex to work on its number. Review the branch, verification evidence, and linked pull request before merging.

For example:

```text
Draft a GitHub Issue for this request. Make the outcome and acceptance criteria concrete before creating it: ...

Work on issue #12. Read its acceptance criteria, inspect the relevant code, make the smallest change on a branch, verify it, and prepare a PR linked to the issue. Ask Theo or Susie for input only if the design needs it; ask Quinn to review the result.
```

## Agents

The project scoped definitions in [`.codex/agents/`](.codex/agents/) are available to Codex as custom agents:

| Agent | Focus |
| --- | --- |
| Maya | Scope, priorities, and coordination |
| Theo | Architecture and technical tradeoffs |
| Sam | Implementation |
| Quinn | Independent review |
| Susie | Product design and usability |

These agents are invoked from a Codex task. They do not watch GitHub Issues or run on a schedule. The shared working rules are in [AGENTS.md](AGENTS.md).

## Reuse for a client

Fork or copy the repo, adapt `AGENTS.md` and the agent definitions to the client's delivery process, and use that repo's GitHub Issues for its queue. Keep client credentials and project data in the client's own environment. Add automation only after the manual issue-to-PR loop works reliably for that team.

The earlier Telegram bot is a proof of concept and is not part of the current workflow. Its persona prompts remain in `lib/` as historical material; the active Codex definitions are in `.codex/agents/`.

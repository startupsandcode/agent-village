# Agent Village

Agent Village is a repo based workflow for managing software work with Codex. GitHub Issues holds the ticket queue; Codex in VS Code is the working surface. The main Codex conversation acts as Maya, the engineering lead, and coordinates specialized agents for architecture, implementation, review, and product design when a task benefits from them.

The workflow runs in VS Code with Codex and GitHub access. The [Village Office](office/) runs locally with reported agent activity and the open issue queue. The single `agent-village` Vercel project hosts the [public synthetic demo](https://agent-village.startupsandcode.com/) at `/` and the invited office at `/office`. The former `agent-village-demo` Vercel project has been deleted.

## Start here

1. Open this repository in VS Code with the Codex extension.
2. Connect to GitHub for issue and pull request work. If you use the GitHub CLI, sign in with `gh auth login`.
3. Start a Codex chat in this repository and talk to Maya directly. Ask her to draft a GitHub Issue from the [work item template](.github/ISSUE_TEMPLATE/work-item.md).
4. Once the issue is ready, ask Maya to coordinate work on its number. Review the branch, verification evidence, and linked pull request before merging.

For example:

```text
Maya, help me turn this request into a GitHub Issue. Make the outcome and acceptance criteria concrete before creating it: ...

Maya, coordinate issue #12. Read its acceptance criteria, give Sam a bounded implementation task if this is a substantive code issue, integrate and verify the result, and prepare a PR linked to the issue. Bring in Theo or Susie when relevant, and have Quinn independently review the code change before merge.
```

## Agents

Maya is John's co-host and the default engineering lead because [AGENTS.md](AGENTS.md) instructs the primary Codex conversation. The project scoped definitions in [`.codex/agents/`](.codex/agents/) are specialist agents:

| Agent | Focus |
| --- | --- |
| Theo | Architecture and technical tradeoffs |
| Sam | Implementation |
| Quinn | Independent review |
| Susie | Product design and usability |

For substantive code issues, Maya delegates a bounded implementation task to Sam and requests Quinn's independent review before merge. Theo and Susie join when architecture or product design calls for them. Maya remains accountable for the result. Agents do not watch GitHub Issues or run on a schedule.

## Village Office

The office is a website on your own machine. It needs Node.js 20 or later and a GitHub CLI login with access to this private repository (`gh auth status`). From the repository root, run:

```bash
export VILLAGE_GITHUB_REPO=startupsandcode/agent-village
node office/server.mjs
```

Open `http://127.0.0.1:4173/office` for the local office; `/` shows the synthetic demo. Five illustrated desks show explicit agent reports. The work board reads open GitHub Issues through `gh` on the server; no GitHub credential is sent to the browser. If the GitHub CLI cannot read the repository, the board explains that updates are unavailable.

Agents report their work from the repository root with:

```bash
node office/checkin.mjs start Maya "Coordinating the office build" 7
node office/checkin.mjs finish Maya
```

Use the agent's own name and a short task summary; the issue number is optional. Each start report lasts 90 minutes. Repeat `start` if work continues, and use `finish` when it ends. The office labels every report with its update time and marks expired reports as last reported. An open issue does not mean anyone is active. Reports live only in ignored local files under `office/.local/`; opening the site from another computer is not supported. See [the office design](docs/office-design.md) for the data and privacy boundaries.

## Maya and the Astra Lab handoff

For an approved Astra Lab request, Maya coordinates the delivery, Sam implements it, and Quinn reviews the exact pull request commit. The worker records progress on the parent issue, uses an isolated worktree, and stops for recovery if the checkout is dirty or an operation is interrupted. It can open a draft pull request, but it does not merge or release. This integration requires the Astra Lab repository's own rules and tools; it is not a general unattended project builder.

## Reuse for a client

Fork or copy the repo, adapt `AGENTS.md` and the agent definitions to the client's delivery process, and use that repo's GitHub Issues for its queue. Keep client credentials and project data in the client's own environment. Add automation only after the manual issue-to-PR loop works reliably for that team.

The active instructions are in `AGENTS.md` and `.codex/agents/`. The retired proof of concept is available in Git history.

## Host the office on Vercel

The existing `agent-village` Vercel project uses `office/` as its root. Its public routes serve the synthetic team demo, workflow explainer, and setup guide. The invited workspace and its APIs use application-level authentication and authorization; public routes and private routes share the same deployment. See the [hosted office guide](office/README.md) for deployment configuration and the [deployment design](docs/office-vercel-design.md) for the route and data boundaries.

## Local Maya chat

For the local project workflow, bounded website build, Maya/Sam/Quinn activity, and reviewed-file export, see [the local interface setup](local/README.md). It runs alongside the existing office and Astra integration. Broader code execution and hosted project workflows have additional setup and safety requirements described in the relevant guides; a configured key or database alone does not mean hosted runs are enabled.

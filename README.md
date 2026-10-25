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

## Emma handoff from Astra Lab

After John selects an Astra project, Emma records a dispatch on its parent issue and invokes `node village/cli.mjs run --repo startupsandcode/astra-lab --issue <parent-issue> --request-id <request-id>` on the active computer. The caller sets `ASTRA_LAB_ROOT`, `EMMA_HOST_ID`, and the claimed `EMMA_ATTEMPT_ID`. The entrypoint checks the shared host and attempt record in Astra issue #5, Astra's PAUSE/config controls, and the approved dispatch before a stage can write. The worker creates or resumes a separate worktree for the first actionable issue, fetching an existing remote implementation branch after a host switch. Maya, Sam, and Quinn run as bounded stages. Sam opens a draft PR linked with `Closes #<issue>`; Quinn reviews the exact checked-out PR commit in read-only mode. Stage starts, results, questions, and answers live on the Astra parent issue. A dirty or interrupted worktree stops for recovery. The worker never merges or releases.

Both checkouts and authenticated `gh` and `codex` CLIs are required on the active Mac or Windows machine. Only one machine should run Emma's schedule. For an offline rehearsal, use the Astra command `python3 -m tests.emma_rehearsal --village-root /path/to/agent-village`; the Village half uses only in-memory fake clients and cannot change production.

## Reuse for a client

Fork or copy the repo, adapt `AGENTS.md` and the agent definitions to the client's delivery process, and use that repo's GitHub Issues for its queue. Keep client credentials and project data in the client's own environment. Add automation only after the manual issue-to-PR loop works reliably for that team.

The active instructions are in `AGENTS.md` and `.codex/agents/`. The retired proof of concept is available in Git history.

## Host the office on Vercel

The `agent-village` Vercel project uses Root Directory `office`. Its public root is a synthetic demo, `/workflow` explains the design-led path from an agreed goal to reviewable proof, and `/office` and `/api/office` require Sign in with Vercel and an invited, verified email through application-level checks. Project-wide Vercel Authentication is disabled so visitors can see the public pages. See the [hosted office setup](office/README.md) for OAuth configuration and access checks.

The existing `agent-village` project can use its `GITHUB_AGENT_TOKEN` environment variable if that token can read Issues in `startupsandcode/agent-village`. The function prefers `GITHUB_ISSUES_TOKEN` when both variables exist. If a new credential is needed, create a **fine-grained personal access token** with access to **only** that repository, **Issues: Read-only**, and the required Metadata read permission. Enter it directly in the Vercel project's **Secret** environment variable form as `GITHUB_ISSUES_TOKEN` for each deployment environment you will use. Do not paste either token into source files, chat, or the public demo. Redeploy after changing the environment variable. A GitHub App is useful later when multiple customers or repositories need their own installations and short-lived credentials; the Vercel viewer sign-in does not replace the server's GitHub credential. See [GitHub's endpoint permission](https://docs.github.com/en/rest/issues/issues#fine-grained-access-tokens-for-list-repository-issues), [Vercel environment variables](https://vercel.com/docs/environment-variables), and [Vercel's All Deployments announcement](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan).

Before inviting viewers, test unauthenticated `/office` and `/api/office`; both must deny access through the app guards. Then sign in with an invited account and verify the issue board loads. The browser receives only selected issue fields and status, never the token. On the draft interface branch, hosted project activity comes from owner-scoped project records; local check-in files still do not persist to Vercel. The local office and `checkin.mjs` continue to work on your machine. See [the deployment design](docs/office-vercel-design.md) for the security boundary.

## Local Maya chat

For a plain-language project goal, provider-backed clarification, a bounded website build, an illustrated office with recorded Maya/Sam/Quinn activity, and a reviewed-file export, see [the local interface setup](local/README.md). It runs alongside the existing office and Astra worker without changing their configuration. The export includes a repeatable receipt test and user-operated GitHub/Vercel publication steps. The draft branch also has a hosted, owner-scoped static-site path that requires an operator allowlist, a dedicated database, a provider key, and explicit activation. A prior protected Preview completed one bounded live OpenAI build and review; a fresh learner setup and Anthropic live run remain unverified. Broader code execution would need a separately bounded executor.

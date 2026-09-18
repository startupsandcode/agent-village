# Agent Village

Agent Village is a repo based workflow for managing software work with Codex. GitHub Issues holds the ticket queue; Codex in VS Code is the working surface. The main Codex conversation acts as Maya, the engineering lead, and coordinates specialized agents for architecture, implementation, review, and product design when a task benefits from them.

The workflow runs in VS Code with Codex and GitHub access. The [Village Office](office/) runs locally with reported agent activity and the open issue queue. A separate Vercel version can serve the private issue board; [the public demo](demo/) contains synthetic data only. The former Vercel project is disconnected from this repository, so pushes do not deploy a site automatically.

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

Maya is the default lead because [AGENTS.md](AGENTS.md) instructs the primary Codex conversation. The project scoped definitions in [`.codex/agents/`](.codex/agents/) are specialist agents:

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
node office/server.mjs
```

Open `http://127.0.0.1:4173`. Five illustrated desks show explicit agent reports. The work board reads open GitHub Issues through `gh` on the server; no GitHub credential is sent to the browser. If the GitHub CLI cannot read the repository, the board explains that updates are unavailable.

Agents report their work from the repository root with:

```bash
node office/checkin.mjs start Maya "Coordinating the office build" 7
node office/checkin.mjs finish Maya
```

Use the agent's own name and a short task summary; the issue number is optional. Each start report lasts 90 minutes. Repeat `start` if work continues, and use `finish` when it ends. The office labels every report with its update time and marks expired reports as last reported. An open issue does not mean anyone is active. Reports live only in ignored local files under `office/.local/`; opening the site from another computer is not supported. See [the office design](docs/office-design.md) for the data and privacy boundaries.

## Reuse for a client

Fork or copy the repo, adapt `AGENTS.md` and the agent definitions to the client's delivery process, and use that repo's GitHub Issues for its queue. Keep client credentials and project data in the client's own environment. Add automation only after the manual issue-to-PR loop works reliably for that team.

The active instructions are in `AGENTS.md` and `.codex/agents/`. The retired proof of concept is available in Git history.

## Host the office on Vercel

Create **two Vercel projects** from this repository. Set one project's Root Directory to `office` and protect it with **Vercel Authentication → All Deployments** before sharing any URL or adding a GitHub credential. Set the second project's Root Directory to `demo` and leave it public. Its issue titles and desk reports are static, synthetic data; it makes no request to GitHub or the private office.

For the private `office` project, create a **fine-grained personal access token** in GitHub with access to **only** `startupsandcode/agent-village`, **Issues: Read-only**, and the required Metadata read permission. Enter it directly in the private Vercel project's **Secret** environment variable form as `GITHUB_ISSUES_TOKEN` for each deployment environment you will use. Do not paste the token into source files, chat, or the public demo project. Redeploy after setting the variable. A GitHub App is useful later when multiple customers or repositories need their own installations and short-lived credentials; an OAuth login is unnecessary for this single-repository read-only board. See [GitHub's endpoint permission](https://docs.github.com/en/rest/issues/issues#fine-grained-access-tokens-for-list-repository-issues), [Vercel environment variables](https://vercel.com/docs/environment-variables), and [Vercel's All Deployments announcement](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan).

Before inviting viewers, test an unauthenticated request to both the private home page and `/api/office`; both must redirect to Vercel sign-in or deny access. Then sign in with an invited account and verify the issue board loads. The browser receives only selected issue fields and status, never the token. The hosted desks currently report activity as unavailable because local check-in files do not persist to Vercel. The local office and `checkin.mjs` continue to work on your machine. See [the deployment design](docs/office-vercel-design.md) for the security boundary and next storage step.

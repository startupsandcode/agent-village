# Local Maya interface

This is the first portable Agent Village slice. A visitor gives Maya a plain-language goal, answers one clarification, reads her plan, then starts a bounded static website build. Sam creates `index.html` and `styles.css` in `local/.workspaces/<project-id>/`. Quinn receives those exact files and their SHA-256 digest for a separate review. The page shows the recorded question, answer, plan, stage starts, file receipt, review, errors, and cancellation. A model review is useful feedback, not proof that the page works for real visitors.

## Start from a fresh clone

You need Node.js 20.12 or newer, existing GitHub access to this private repository, and an API key from either OpenAI or Anthropic. An **OpenAI API key** is a credential for the OpenAI developer API; it is separate from a ChatGPT subscription. Provider API calls may be billed to your provider account. Four calls is the maximum in one completed project (clarification, plan, build, review). Each call has a 45-second timeout, a 32,768-byte input cap including instructions, and an 1,800 output-token cap; actual input and provider charges vary. This interface does not make calls until you submit a goal.

```sh
git clone --branch village-interface-20261011-01 --single-branch https://github.com/startupsandcode/agent-village.git
cd agent-village
```

While [draft PR #30](https://github.com/startupsandcode/agent-village/pull/30) is unmerged, the branch option above is required. After merge, a normal clone of `main` will contain the interface.

In a local `zsh` terminal, choose **one** provider and enter the key at a silent prompt. Do not paste it into the browser, chat, a command line argument, a tracked file, or a Git commit:

Alternatively, create a private `.env.local` file at the repository root with `VILLAGE_PROVIDER=openai` and `OPENAI_API_KEY=your-own-key` (or `VILLAGE_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=your-own-key`). Run `chmod 600 .env.local` before starting the server; startup rejects files readable by other local users. `node local/server.mjs` loads it at startup. Git ignores `.env.local`; keep the file private on your computer and never share it. Already exported shell variables take precedence. The setup guide at `/setup` explains both methods and the hosted Preview separately.

```sh
export VILLAGE_PROVIDER=openai
read -s "OPENAI_API_KEY?OpenAI API key: "
export OPENAI_API_KEY
printf '\n'
node local/server.mjs
```

For Anthropic, use `VILLAGE_PROVIDER=anthropic` and `read -s "ANTHROPIC_API_KEY?Anthropic API key: "` followed by `export ANTHROPIC_API_KEY`. The defaults are `gpt-4.1-mini` and `claude-sonnet-5-5`; override with `VILLAGE_OPENAI_MODEL` or `VILLAGE_ANTHROPIC_MODEL` if your account needs another available model. The key remains in the server process environment and in the terminal session until you unset it or close the terminal. It is not saved by the app. The server listens only on `127.0.0.1:4174`; open <http://127.0.0.1:4174/>. If the key is absent, the page explains the missing variable. After cloning, running the chat needs no GitHub token, npm install, or Vercel deployment.

The website preview is static and has a restrictive Content Security Policy. Sam cannot execute shell commands or choose file paths in this slice. Generated files are ignored by Git and confined to `local/.workspaces/<project-id>/`. The interface records prompts and outputs locally as project state there. Use goals without secrets or sensitive data. A changed artifact loses its review receipt on the next status or artifact request. The local workspace remains trusted same-user disk space; another process with write access can still alter project files. To clear local project history, stop the server and remove the relevant directory under `local/.workspaces/`.

## Your first office and project

1. Open the local page and enter a name in **Name your office**. The name is saved to ignored `local/.workspaces/office-setup.json` and stays on this computer. You may instead set `VILLAGE_OFFICE_NAME='My Village'` in the server shell to fix the name there. Answer the three optional domain questions in the interface; they are saved to ignored `local/.workspaces/domain-profile.json`. New projects snapshot this context and pass it to Maya, Sam, and Quinn. Editing it later does not rewrite prior projects. Do not enter secrets or private customer data. No John account or project record is copied into a fresh clone.
2. Choose OpenAI or Anthropic and enter **your own** key using the silent prompt above. A ChatGPT subscription is not an OpenAI API key. Do not add key values to the repository, a `.env.example`, chat, or browser storage.
3. Open the local office, give Maya a small **static website** goal, answer the question, read the plan, then choose Build. The desks show only recorded current stages. Inspect the event trail, generated files and preview. The build runs structural and non-executable-content checks; Quinn separately reviews the exact HTML and CSS digest. This is a bounded static site path, not a general code executor.
4. Once Quinn approves, choose **Prepare reviewed files**. The office displays the standalone project directory. It contains `index.html`, `styles.css`, a receipt-checking test, `package.json`, `.vercelignore`, and a README. It contains no chat history or provider key. In a terminal, change to that displayed directory and run `npm test`. The test checks the exact delivery file set and both file receipts; `.git` and `.vercel` are permitted local metadata and explicitly excluded from Vercel upload. Added files or directories fail the test and another Prepare request. Inspect the site before publishing.
5. **Check my local CLI connections** reads existing `gh` and `vercel` CLI account names with read-only commands. It sends neither the provider key nor chat history to those commands. This is informational and does not grant publishing permission. The separate publish buttons below use server-side publishing credentials.

### Publish from the local interface

The two publish buttons appear after **Prepare reviewed files**. They act only when you press them. The interface never collects publishing tokens. If you want GitHub publication, first create a dedicated **private** repository and a non-default branch in your own account. Initialize it with a harmless `notes.txt`, since a README or other delivery filename would collide. Verify it has no Actions, Pages, webhooks or connected production deployment: a GitHub push can trigger external automation even on a non-default branch. Give the local server `VILLAGE_PUBLISH_GITHUB_TOKEN` through your private `.env.local`; use a fine-grained GitHub token with **Contents: read and write** on only that repository. The button checks the exact owner, repository, branch, privacy, Pages setting, branch `.github` directory and permissions, refuses conflicting delivery files, then commits the six receipt-checked files without force pushing. It cannot inspect external webhooks with a Contents-only token. It preserves unrelated files. A retry with the same files returns the existing commit.

For a Vercel Preview, first select or create an **existing static Vercel project** in your own team with its root directory at the project root. Set `VILLAGE_PUBLISH_VERCEL_TOKEN` in the same private server environment. The Vercel token should be limited to the intended team where supported. Enter the exact team slug and project name in the interface. The button checks the project, then sends only the reviewed HTML and CSS to Vercel's deployment API. It requests Preview, never Production, and reports the deployment ID and observed state. A queued deployment is not a verified working site; use **Check Preview status**. The local receipt blocks duplicate submissions, including after a server restart. If a submission is interrupted after it may have reached Vercel, the interface blocks an automatic retry until you inspect the target deployment.

These are two separate, explicit writes. Publishing to GitHub does not create a repository, and the direct Vercel Preview upload does not connect a GitHub repository or automatically update Production. A Vercel token may have broader team privileges than one project; verify the team and project before pressing Publish. Preview URLs can be shared unless you enable [deployment protection](https://vercel.com/docs/deployment-protection). There has been no live publish test in this PR; the tests use mocked GitHub and Vercel APIs.

### Hosted private office

The existing Vercel office uses application-level Sign in with Vercel and an invited-email list. A clone must configure its **own** confidential Vercel OAuth app, exact `OFFICE_ALLOWED_ORIGINS`, invited emails, session signing secret, and server-only provider key. See `office/.env.example` for variable names and `office/README.md` for the auth flow. Enter values in your own Vercel project's secret environment settings, never in Git. The new `/api/maya-status` route applies the same session authorization and reports only whether a provider key is present, without returning or validating it.

Hosted Maya runs require explicit activation in the selected deployment. The local engine persists projects in ignored files, which do not survive Vercel function cold starts or redeploys. The hosted code path now has an owner-scoped Postgres store, transactional budget claims, a session-bound coordinator, authenticated route, and a small chat that appears only in explicitly enabled test mode. The existing Vercel OAuth `sub` is the owner key. This path is tested with in-memory/fake adapters; it has not used a live database or provider. The current static renderer does not execute model-written code, so a Sandbox is unnecessary for this first hosted artifact type. Broader coding work would need a separately provisioned [Vercel Sandbox](https://vercel.com/docs/sandbox) with strict time, file and network limits. Hosted execution requires an operator allowlist, private database, provider key and explicit activation; a viewer session alone cannot spend. GitHub and Vercel publishing need separate, scoped user authorization and explicit target confirmation. A paid hosted test needs the owner to connect a database, configure his own OAuth callback and allowed origin, and enter his own provider key in server-only Vercel secrets. No value is entered by this PR.

The usage panel counts this Village's recorded provider calls and response tokens by project and agent, with a current-month local total. It does not read ChatGPT or Codex subscription quota. Cost estimates use the [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) and [Claude Sonnet 5.5](https://platform.claude.com/docs/en/about-claude/pricing) published API rates checked 2026-10-11; provider billing is authoritative. Calls without a usage response stay unreported or pending and may still incur charges. Hosted deployments need the additive `office/hosted/002_usage.sql` migration after `001_projects.sql`; `/api/maya-health` reports `usageReady` separately from the original tables.

The existing Astra Lab worker in `village/` and the hosted Village Office have separate purposes and credentials. This local slice does not run them or submit issues, PRs, or messages. It can commit a reviewed site to a user-selected private branch and submit a Vercel Preview only after the corresponding user button is pressed and the server has a separate publishing credential. The first artifact type is a small landing page; broader coding work needs a separate bounded design and tool permissions.

## Verification

```sh
node --test local/test/*.test.mjs
node --check local/server.mjs
node --check local/engine.mjs
node --check local/providers.mjs
node --check local/artifact.mjs
node --check local/public/app.js
```

Tests use a deterministic fake provider. They do not establish live OpenAI or Anthropic success. A paid live test needs a user-supplied key through the local shell setup above. Inspect `local/.workspaces/<project-id>/state.json` and the generated files for the event trail and artifact. Review messages are marked as model review; browser behavior still deserves a human check before sharing the result.

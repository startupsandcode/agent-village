# Local Maya interface

This is the first portable Agent Village slice. A visitor gives Maya a plain-language goal, answers one clarification, reads her plan, then starts a bounded static website build. Sam creates `index.html` and `styles.css` in `local/.workspaces/<project-id>/`. Quinn receives those exact files and their SHA-256 digest for a separate review. The page shows the recorded question, answer, plan, stage starts, file receipt, review, errors, and cancellation. A model review is useful feedback, not proof that the page works for real visitors.

## Start from a fresh clone

You need Node.js 20 or newer, existing GitHub access to this private repository, and an API key from either OpenAI or Anthropic. An **OpenAI API key** is a credential for the OpenAI developer API; it is separate from a ChatGPT subscription. Provider API calls may be billed to your provider account. Four calls is the maximum in one completed project (clarification, plan, build, review). Each call has a 45-second timeout and an 1,800 output-token cap; actual input and provider charges vary. This interface does not make calls until you submit a goal.

```sh
git clone --branch village-interface-20261011-01 --single-branch https://github.com/startupsandcode/agent-village.git
cd agent-village
```

While [draft PR #30](https://github.com/startupsandcode/agent-village/pull/30) is unmerged, the branch option above is required. After merge, a normal clone of `main` will contain the interface.

In a local `zsh` terminal, choose **one** provider and enter the key at a silent prompt. Do not paste it into the browser, chat, a command line, a file, or a Git commit:

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

1. Choose your office name in the same shell before starting: `export VILLAGE_OFFICE_NAME='My Village'`. This changes the local office branding; the Maya, Sam, and Quinn roles work without customization. No John account or project record is copied into a fresh clone.
2. Choose OpenAI or Anthropic and enter **your own** key using the silent prompt above. A ChatGPT subscription is not an OpenAI API key. Do not add key values to the repository, a `.env.example`, chat, or browser storage.
3. Open the local office, give Maya a small **static website** goal, answer the question, read the plan, then choose Build. The desks show only recorded current stages. Inspect the event trail, generated files and preview. The build runs structural and non-executable-content checks; Quinn separately reviews the exact HTML and CSS digest. This is a bounded static site path, not a general code executor.
4. Once Quinn approves, choose **Prepare reviewed files**. The office displays the standalone project directory. It contains `index.html`, `styles.css`, a receipt-checking test, `package.json`, and a README. It contains no chat history or provider key. In a terminal, change to that displayed directory and run `npm test`. Inspect the site before publishing.

### Put the reviewed site in your own GitHub and Vercel accounts

These are intentional terminal actions, not background steps in the office. They can create a repository, upload files, create a Vercel project, and incur service usage. Review the target account and project before each write. If you already have a repository or Vercel project, select it deliberately instead of creating a duplicate.

```sh
# Run these from the prepared site directory shown by the office.
npm test
gh auth login --web             # only if your own GitHub CLI is not already connected
gh auth status
gh api user --jq .login         # confirm the account that will own the repository
git init -b main
git add index.html styles.css verify.test.mjs package.json README.md
git commit -m 'Initial reviewed website'
gh repo create YOUR-USER/YOUR-SITE --private --source=. --remote=origin --push
vercel login                   # sign in to your own Vercel account if needed
vercel whoami
vercel link                    # choose the intended team and project
vercel project inspect --non-interactive
vercel deploy                  # preview; verify the returned URL and target
```

The `gh repo create` command is a **new private repository** path. For an existing repository, inspect its remote and history before choosing your own push commands. Do not run the example with `YOUR-USER/YOUR-SITE` literally. A Vercel preview can still be reachable by anyone with its URL unless you configure deployment protection. Production release is a separate deliberate action. The interface itself never executes these commands or claims their result. [GitHub CLI repository creation](https://cli.github.com/manual/gh_repo_create) and [Vercel deploy](https://vercel.com/docs/cli/deploy) describe the current CLI actions.

### Hosted private office

The existing Vercel office uses application-level Sign in with Vercel and an invited-email list. A clone must configure its **own** confidential Vercel OAuth app, exact `OFFICE_ALLOWED_ORIGINS`, invited emails, session signing secret, and server-only provider key. See `office/.env.example` for variable names and `office/README.md` for the auth flow. Enter values in your own Vercel project's secret environment settings, never in Git. The new `/api/maya-status` route applies the same session authorization and reports whether the provider is configured without returning its key.

Hosted Maya runs are **not available yet**. This local engine persists projects in ignored files, which do not survive Vercel function cold starts or redeploys. An authenticated, owner-scoped durable store and an isolated build executor are required before exposing hosted chat, build, artifact, or deployment routes. The hosted office says so rather than offering a button that cannot work. A signed-in viewer is not authorized to spend API credits, publish to GitHub, or deploy.

The existing Astra Lab worker in `village/` and the hosted Village Office have separate purposes and credentials. This local slice does not run them or submit issues, PRs, messages, or deployments. The first artifact type is a small landing page; broader coding work needs a separate bounded design and tool permissions.

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

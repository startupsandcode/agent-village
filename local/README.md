# Local Maya interface

This is the first portable Agent Village slice. A visitor gives Maya a plain-language goal, answers one clarification, reads her plan, then starts a bounded static website build. Sam creates `index.html` and `styles.css` in `local/.workspaces/<project-id>/`. Quinn receives those exact files and their SHA-256 digest for a separate review. The page shows the recorded question, answer, plan, stage starts, file receipt, review, errors, and cancellation. A model review is useful feedback, not proof that the page works for real visitors.

## Start from a fresh clone

You need Node.js 20 or newer and an API key from either OpenAI or Anthropic. An **OpenAI API key** is a credential for the OpenAI developer API; it is separate from a ChatGPT subscription. Provider API calls may be billed to your provider account. Four calls is the maximum in one completed project (clarification, plan, build, review). Each call has a 45-second timeout and an 1,800 output-token cap; actual input and provider charges vary. This interface does not make calls until you submit a goal.

```sh
git clone https://github.com/startupsandcode/agent-village.git
cd agent-village
```

In a local `zsh` terminal, choose **one** provider and enter the key at a silent prompt. Do not paste it into the browser, chat, a command line, a file, or a Git commit:

```sh
export VILLAGE_PROVIDER=openai
read -s "OPENAI_API_KEY?OpenAI API key: "
export OPENAI_API_KEY
printf '\n'
node local/server.mjs
```

For Anthropic, use `VILLAGE_PROVIDER=anthropic` and `read -s "ANTHROPIC_API_KEY?Anthropic API key: "` followed by `export ANTHROPIC_API_KEY`. The defaults are `gpt-4.1-mini` and `claude-sonnet-5-5`; override with `VILLAGE_OPENAI_MODEL` or `VILLAGE_ANTHROPIC_MODEL` if your account needs another available model. The key remains in the server process environment and in the terminal session until you unset it or close the terminal. It is not saved by the app. The server listens only on `127.0.0.1:4174`; open <http://127.0.0.1:4174/>. If the key is absent, the page explains the missing variable. No GitHub login, npm install, or Vercel deployment is needed for this local flow.

The website preview is static and has a restrictive Content Security Policy. Sam cannot execute shell commands or choose file paths in this slice. Generated files are ignored by Git and confined to `local/.workspaces/<project-id>/`. The interface records prompts and outputs locally as project state there. Use goals without secrets or sensitive data. To clear local project history, stop the server and remove the relevant directory under `local/.workspaces/`.

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

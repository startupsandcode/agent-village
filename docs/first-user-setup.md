# First user setup: Windows and local Agent Village

This guide uses the local, single-user static-site workflow. It does not set up the private hosted office, publish a site, or connect a provider until you choose to run a project.

A public clone lets you inspect and adapt the source, run deterministic tests with fake providers, and use the local interface with your own provider key. It does not grant upstream write permissions, hosted office access, or authorization to run autonomous missions in other repositories. The Codex issue-to-PR workflow in the root README is a separate path requiring Codex and GitHub authentication for write actions.

## What you need

- Windows 10 or 11 with PowerShell.
- Git and Node.js 20.12 or newer (`node --version`).
- A clone of the public `startupsandcode/agent-village` GitHub repository. No invitation, GitHub login, GitHub CLI, or GitHub token is required to clone it or use the local workflow.
- Your own OpenAI or Anthropic API key for a live project. A ChatGPT subscription is not an API key. Provider API calls can incur separate charges.

The normal project makes four provider calls: Maya clarification, Maya plan, Sam build, and Quinn review. If Quinn rejects the artifact, the interface allows one bounded Sam revision and a new Quinn review. A failed revision and failed re-review can each be retried once; the hard limit is eight calls per project. This is a call limit, **not a dollar spending limit**. Before a live run, set a hard spending limit with your provider. No live paid-provider calls were made during the acceptance work for this guide.

## Clone and start

Open PowerShell and run:

```powershell
git clone https://github.com/startupsandcode/agent-village.git
Set-Location agent-village
node --version
```

Confirm Node is at least `v20.12.0`. No `npm install` is needed for the local interface.

Choose one provider. This PowerShell prompt hides the key while you type and keeps it in the current shell environment; it does not write the key to a file or Git. Start the server from the repository root.

### OpenAI

```powershell
$env:VILLAGE_PROVIDER = 'openai'
$secret = Read-Host 'OpenAI API key' -AsSecureString
$keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
  $secret.Dispose()
}
node local/server.mjs
```

### Anthropic

Use this instead of the OpenAI block:

```powershell
$env:VILLAGE_PROVIDER = 'anthropic'
$secret = Read-Host 'Anthropic API key' -AsSecureString
$keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
  $secret.Dispose()
}
node local/server.mjs
```

Open <http://127.0.0.1:4174/> in your browser. Stop the server with `Ctrl+C`. Then remove the key from the PowerShell session:

```powershell
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:VILLAGE_PROVIDER -ErrorAction SilentlyContinue
```

The server listens on loopback only. It reads a root `.env.local` if you choose to create one, but the steps above avoid saving a provider key to disk. Do not put keys in browser fields, chat, command arguments, screenshots, or tracked files.

## Complete a first project

1. On the first visit, enter a local office name. Optionally add the three domain answers; they stay in this computer's ignored local workspace and are copied into new project context. Avoid secrets and private customer data.
2. Describe one small static website. Submitting the goal makes Maya's clarification call. Answer the question and read Maya's plan.
3. Choose **Build the website** only when you want to authorize the Sam build and Quinn review calls. The plan does not authorize a build on its own.
4. Inspect the event trail, HTML/CSS files, preview, structural checks, and Quinn's model-review result. A model review is useful feedback, not a browser test or guarantee that visitors will understand the site.
5. If Quinn requests changes, choose **Revise using Quinn's findings** once, then **Ask Quinn to review the revision**. A changed artifact has a new hash and the old review does not approve it.
6. After Quinn approves the exact current artifact, choose **Prepare reviewed files**. In the shown export folder, run:

   ```powershell
   Set-Location '<the export path shown by the app>'
   npm test
   ```

   Review the standalone files before sharing or publishing. Export does not publish anything. GitHub and Vercel publishing are separate explicit actions that need their own scoped server credentials and target checks; skip them for a first local run.

Project history and generated files are stored under the local ignored `local/.workspaces/` directory. This workflow has no sign-in or multi-user boundary on the same computer: treat local files as accessible to other processes running as your Windows user. The export contains the approved static site and its receipt check, not the chat history or provider key.

## Hosted office is a separate setup

The private hosted office at `/office` uses Vercel sign-in, an invited-email allowlist, server-side configuration, a dedicated database, an operator allowlist, and an explicitly activated hosted-run feature. A provider key or a successful public homepage response does not prove that a new user's hosted flow is ready. See [the hosted office setup](../office/README.md) before configuring it. Do not test live hosted runs until a provider-side spend limit and an authorized test context are in place.

## Verification evidence and limits

The repository's deterministic tests use fake providers and temporary local data; they do not make provider calls. The suite includes local office/project setup, plan/build/review, Quinn rejection/revision, export receipt verification, hosted owner-scoped storage, and transactional budget enforcement. These fixtures establish code behavior at the tested boundaries, not a real multi-account database deployment.

For current acceptance evidence and the hosted checks that still require a signed-in test context, see the issue and pull request linked from the project repository. A public `/` response verifies only that the public page is served; it does not verify the private office, owner isolation in the deployed database, a real provider run, or a new user's end-to-end experience.

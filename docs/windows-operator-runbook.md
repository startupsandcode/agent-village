# Issue #28: manual Agent Village operator runbook

This is the **Mac fallback record** for [issue #28](https://github.com/startupsandcode/agent-village/issues/28), whose original request was a Windows runbook. The Mac procedure and evidence below do not verify Windows execution. The endpoint for this pilot is a reviewed **draft** pull request, not a merge, deployment, background worker, or autonomous issue pickup.

## Verified on the Mac attempt

The attempt ID is `mac-20261009-2b554d6b-5a3f-4fe3-a19a-d9d55a87c84d`, on branch `issue-28-mac-operator-runbook` in a separate clean worktree initially at `89ee908ecc018ea2eb6f1b90b00e394f0cc5de1c`. Maya's distinct Codex CLI session `01a122dc-3d9b-7c10-a1a3-c99cd22e7f8b` explicitly acknowledged the issue, Mac scope, branch, and proposed Sam and Quinn handoffs. Her first stage was read-only and stopped before editing. The prior Windows attempt, `issue-28-windows-operator-runbook`, remains stopped and separate; it produced no acknowledgment, documentation commit, issue comment, or PR as reported by the operator. Do not resume it to complete this pilot.

| Check | Mac observation on 2026-10-09 | Limit |
| --- | --- | --- |
| Shell and tools | An ordinary shell command ran; Node `v26.0.0`, Git `2.54.0`, and Codex CLI `0.156.1` were reported. This worktree resolved `codex` to `/opt/homebrew/bin/codex`. | Availability is host and session specific. |
| Codex authentication | `codex login status` returned `Logged in using ChatGPT`. | Login alone does not start an agent. |
| Codex session | A bounded `codex exec -C <Mac worktree> -s read-only -o <output> - <prompt` completed with exit 0 and produced Maya's acknowledgment. | The initial default-sandbox launch failed before session start because `~/.codex/state_5.sqlite` was read-only. An operator resolved that narrow launch failure; it is not a reason to relax project security or edit authentication. |
| GitHub | Connected GitHub access read the open issue, with zero comments and no matching remote branch or PR at preflight. | Local `gh auth status` reported an invalid token. `git ls-remote` over SSH failed on DNS. Remote writes must be rechecked before attempting a draft PR. |
| Repository baseline | `node --test village/test/cli.test.mjs` passed 5 tests. | This tests the Astra bridge code, not the manual handoff or Windows. |

The current private [JohnOS communication protocol](https://github.com/startupsandcode/john-os/blob/main/docs/agent-communication-protocol.md) supplies the handoff, acknowledgment, checkpoint, and result contract. The parent operator alone writes JohnOS `TASKLOG.md`; specialists return evidence to that operator. An issue, office desk, or dashboard is not evidence that an agent accepted work.

## Prerequisites and one-task preflight

1. Use an authorized Mac Codex session in this Agent Village checkout, a separate clean worktree for issue #28, and the existing [AGENTS.md](../AGENTS.md) and [README.md](../README.md) rules. Verify `git status --short --branch` and the intended base and branch before editing. Preserve unrelated or dirty work; stop on a conflict.
2. Read the current issue, existing comments, branches, PRs, and previous attempt record. Reconcile any uncertain launch before retrying. Keep the Windows attempt stopped and never run two attempts against the same files.
3. Confirm Node, Git, Codex CLI, and existing authentication without displaying tokens. Use `codex login status` and `gh auth status` as status checks only. If GitHub writes are unavailable, complete local documentation and review but stop before promising a PR. Do not create credentials, change persistent PATH, or grant access.
4. Confirm that John's approval still covers this one documentation file, manual agent dispatch, independent review, and a draft PR. Stop for any new file scope, paid service, external communication, scheduler, merge, deployment, or security change.

For a process-local Mac invocation, use the authenticated executable found on this host. These are operator templates; replace placeholders and inspect the output before every next stage:

```sh
WORKTREE=/absolute/path/to/issue-28-mac-operator-runbook
CODEX_BIN=/opt/homebrew/bin/codex
"$CODEX_BIN" login status
"$CODEX_BIN" exec -C "$WORKTREE" -s read-only -o /tmp/agent-village-maya-ack.txt - < /tmp/agent-village-maya-prompt.txt
```

The `/tmp` prompt and output files must contain task context only, never credentials. `-C`, `-s read-only`, `-o`, and `-` are supported by the installed `codex exec --help`; the Mac acknowledgment used that form. A writable implementation stage needs its own authorized, isolated runtime. The successful read-only acknowledgment does **not** prove write capability or a continuously running team. Avoid persistent shell configuration changes.

## Manual handoff, checkpoint, and return

1. **Emma to Maya:** The authorized operator gives the existing Codex session one packet: stable JohnOS Task ID, issue #28, priority, outcome, acceptance checks, Mac attempt ID, branch/worktree, permitted file `docs/windows-operator-runbook.md`, exclusions, approval reference, return thread, and next checkpoint. Ask Maya to acknowledge before implementation. A prepared packet is not delivered, and delivery is not acceptance.
2. **Maya ACK/START:** Maya replies with accepted scope, attempt and session IDs, clean/conflict check, start evidence, and checkpoint. The Mac session above supplied the explicit ACK and bounded Sam/Quinn assignments. Its read-only limit is a reported blocker for that stage, not a completed artifact.
3. **Maya to Sam:** Give Sam only the runbook file and current issue/protocol context. Sam writes and commits the exact change, then returns commit SHA, file list, checks, and limits. Maya owns integration; Sam's implementation is distinct work, not a second owner of the cross-agent task.
4. **Checkpoint:** Maya or the operator records an evidence-backed update in the agreed return thread: task/attempt IDs, verified progress, blocker and who can unblock it, and the next milestone. The sole JohnOS board writer updates `TASKLOG.md` from that report. Do not infer progress from silence, an issue label, a process launch, or an office desk.
5. **Quinn review:** After Sam commits, Quinn independently reads the exact commit and issue criteria. Quinn returns findings or approval tied to that SHA, including command/link accuracy, Windows caveat, scope, and stop rules. Maya addresses findings and asks for review of any changed commit.
6. **Maya result:** Verify the final diff, local links and commands, clean branch state, and Quinn's review evidence. Recheck remote activity, then open a draft PR linked to issue #28 if authenticated write access works. Return PR URL, exact commit, criterion-by-criterion evidence, checks, remaining limits, and external actions. Emma verifies the issue, actual specialist evidence, draft PR, and runbook before accepting the pilot. A draft PR is not merged work.

Use the protocol's `ASSIGN`, `ACK / START`, `UPDATE`, and `RESULT` fields rather than inventing a second status system. The canonical return path and checkpoint must be specified in the actual packet; this page cannot establish delivery by itself.

## Stop and retry

Stop on a dirty worktree, missing acknowledgment, unavailable agent capability, ambiguous prior attempt, overlapping branch or file ownership, failed authentication needed for the next action, or any new permission requirement. Report the exact blocker and preserve all work. Before retrying, inspect the destination thread, session, process, issue, branch, and PR for evidence that the earlier attempt landed. Reuse the Task ID for a retry, assign a new attempt ID for an actual restart or host switch, and record the old attempt's terminal state. Do not treat a missed checkpoint as proof of termination. Do not reset another attempt's changes or bypass a pause.

## Route boundaries and Windows status

- **Manual Agent Village route:** A person or authorized operator starts a Codex session in this repository and gives Maya the bounded issue. Maya delegates to actual Sam and Quinn sessions and reports their separate evidence. There is no general GitHub issue watcher or recurring pickup in [AGENTS.md](../AGENTS.md).
- **Village Office:** `node office/checkin.mjs start <agent> "<summary>" [issue-number]` and `finish <agent>` write local activity reports for the named agent. They do not dispatch tasks or prove agent work. The office issue board needs working `gh` access; the invalid Mac `gh` token limits it. See [office design](office-design.md).
- **Astra-only bridge:** [`village/cli.mjs`](../village/cli.mjs) accepts `startupsandcode/astra-lab` and uses Astra's shared host, attempt, and pause controls. It is outside this issue and must not be invoked or modified for the manual Agent Village pilot. Its tests do not validate this handoff.
- **Windows:** The issue's Windows prerequisites and reported Codex PATH problem describe the stopped earlier attempt, not a verified current host. No PowerShell launch, Windows authentication, Maya acknowledgment, file edit, commit, or PR was verified in this Mac attempt. A Windows operator must separately locate that host's authenticated Codex executable, consult its installed CLI help, check its clean isolated worktree and prior attempts, and run a new explicitly authorized attempt. Do not copy the Mac executable path or claim this page proves Windows works.

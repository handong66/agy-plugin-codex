---
name: agy
description: Use when the user asks Codex to run the Antigravity CLI (agy), continue an agy conversation, or request an agy review, adversarial review, or rescue diagnosis.
---

# agy for Codex

Plugin source and tests define machine behavior; this Skill only explains tool selection and
boundaries. Where they disagree, the source wins.

Read results from `structuredContent`, not from the text block. A payload over 8192
characters is returned once, as `structuredContent`, and the text block carries a
`structuredContentOnly` notice instead of a copy.

Every tool returns one envelope: `{ ok, error?, warnings, data }`. The payload lives in
`data`. A few cheap scalars are mirrored at the top level for convenience — `background`,
`terminal`, `nextAction`, `waited`, `resumable`, `agyConversationId`, `observedModel`,
`errorClass`, `exitCode`, `workspaceMode`, `readOnly`, `view`, plus the read-tail scalars
(`references/failure-routing.md` has the full list of twenty) — while the bulk fields
(`job`, `record`, `stdout`, `stderr`, `outputSummary`, `models`) live in `data` and nowhere
else. `warnings` is always an array and is where this plugin puts everything it noticed but
did not refuse over; several of them are load-bearing, so read them.

Boundary refusals come back as that same envelope with `ok: false` and a typed
`error.code`: `workspace_unavailable`, `workspace_out_of_bounds`, `workspace_required`,
`file_attachment_invalid`, `private_path_blocked`, `prompt_too_large`, `mirror_failed`,
`state_write_failed`, `cli_not_found`, `cli_probe_timeout`, `job_not_found`,
`model_not_found`. All are `retryable: false` except `cli_probe_timeout`. Never work around
one by calling the `agy` CLI directly — see the warning under "Choose a tool".

Those codes normally arrive synchronously: every input check runs before a job is created, so
they come back on the submitting call rather than on a job record. One route delivers a typed
refusal later — a background worker that hits one after the job was accepted files that same
code as the job's `errorClass`, so `agy_status` and `agy_result` can hand you a boundary code
too, with the same meaning and the same `retryable` value. `mirror_failed` is the only code
that takes that route in practice.

`references/failure-routing.md` is the complete failure and polling table, vendored with the
plugin so it cannot be a release behind the code. A test fails the build in both directions
if a code exists in one and not the other.

## What makes agy different

Three properties of the Antigravity CLI shape every tool here, and an orchestrator that
assumes otherwise will misread the results. All three are measured, and
the repository's `docs/AGY-RUNTIME-CONTRACT.md` carries the probes
(<https://github.com/handong66/agy-plugin-codex/blob/main/docs/AGY-RUNTIME-CONTRACT.md>; it is
not shipped inside the installed plugin).

**agy cannot see a directory it was not given.** It ignores the process working directory
entirely; without `--add-dir` it operates inside `~/.gemini/antigravity-cli` and sees none of
the repository. So `cwd` is not a convenience here, it is the whole of what a run can reach,
and a call with no resolvable workspace is refused with `workspace_unavailable` rather than
run. (`workspace_required` exists in the vocabulary as an internal guard and has no runtime
path; route on `workspace_unavailable`.)

**agy cannot read without also being able to write.** Headless runs auto-deny every tool
call unless permissions are skipped wholesale; `--sandbox` does not help, and plan mode
refuses reads and shell commands too. There is no flag that grants read and withholds write.

The isolation rationale and failure-classification wording derived from the agy 1.1.16
permission finding have not yet been revisited for agy 1.1.18; that remains open work.

**agy 1.1.18 reports its own outcome independently of its exit code.** In agy 1.1.18, exit 0
covers `SUCCESS`, `CANCELED`, and silent wrong-workspace `SUCCESS`, so exit 0 does not establish
that the requested work happened. For agy 1.1.18, read `outputSummary`, not the exit code, as
the verdict.

## Choose a tool

- **Diagnose first, once per session.** `agy_check` reports the binary, the version, whether
  the account is signed in, which model ids it can reach, the workspace roots this plugin can
  see, and any proxy in effect. The model listing is also the sign-in check, so leave
  `includeModels` alone unless you deliberately want to skip it. The answer is cached for the
  life of the server process; `force: true` re-reads it. Call it at the start of a batch, not
  before every task.
- **Delegate work.** `agy_run` for a task, `agy_continue` (which needs a `conversationId`) to
  carry one on. Both are **write-capable in `cwd`** — that is not a setting, it is the only
  mode agy has. Both accept `allowCodexPrivatePaths`, which only widens what the prompt may
  mention and grants agy nothing.
- **Review without risk to the repository.** `agy_review` and `agy_adversarial_review` give
  agy a disposable copy of the working tree and never tell it the repository's path. See
  "Read-only means the filesystem". Both take `target` (what to review, in words — default is
  the whole working tree). `agy_adversarial_review` also takes `threatModel`: pass it whenever
  the user has stated an operating context, because it makes every finding label itself
  in-model or out-of-model, and an out-of-model finding is advisory only — never a blocker,
  never a NO_GO, never a reason to stop work in progress.
- **Ask why something is stuck.** `agy_rescue`, whose task text goes in `problem`. It is
  deliberately NOT isolated: a rescue
  usually needs to run commands and try things in the real tree. Use `agy_review` when you
  want an opinion that cannot touch anything.
- **Manage background work.** `agy_status`, `agy_result`, `agy_cancel`.
- **Recover a lost handle.** `agy_conversations` lists the conversations this plugin started,
  scoped to the current workspace by default (`includeAllDirectories` widens it). It reads
  only the plugin's own job records and never runs agy, so unlike every execution tool it
  degrades rather than refusing when no workspace root is available: you get an unscoped
  listing and a warning saying so. It scans the 500 newest job records and reports how many in
  `data.scanned`, so on a long-lived state directory an old conversation can fall outside that
  window. agy publishes no conversation listing of its own, so a conversation started by a bare
  `agy` invocation cannot appear here.

Never invoke the `agy` CLI directly through a shell tool. A direct call bypasses the
workspace validation, the read-only isolation, the prompt boundary, and the job record — and
a direct call that forgets `--add-dir` does not fail, it silently runs inside agy's own state
directory and reports success.

## Read-only means the filesystem, and only the repository

`agy_review` and `agy_adversarial_review` are read-only in a specific, checkable sense: agy
is handed a throwaway copy of the working tree and is never given the repository's path, so
nothing it does can reach your files. That is a filesystem guarantee, not a promise about
model behaviour, and it is the only honest one available given that agy has no read-only
mode.

Three consequences to hold onto:

- **The copy is built from git's file list**, so these tools need a git repository and fail
  with `mirror_failed` outside one. There is no fallback that copies an arbitrary directory.
  The check happens at submission, so a background review outside a repository refuses
  immediately with that code rather than handing you a jobId that dies later.
- **Files git ignores are absent** — `node_modules`, build output, `.env`. A finding that
  amounts to "this import does not resolve" or "this file is missing" is an artifact of the
  copy, not a defect. The reviewer is told this in its own prompt, but check anyway.
- **Isolation protects the repository, not the whole filesystem.** agy still writes to
  `~/.gemini/antigravity-cli` on every run. If a review reports that it fixed something, it
  did not: `data.isolation.warnings` will carry `readonly_run_wrote_files` naming what it
  changed inside the copy that was then deleted. Re-run it with `agy_run` to apply a change
  for real.

`data.isolation.warnings` may also carry `tree_changed_during_readonly_run`. That one means
the real tree or HEAD moved while an isolated review was running, which the review should not
have been able to cause. Treat the verdict with suspicion and check `git status` yourself.

## Model selection

Omit `model` and let agy choose. When you do pass one, pass an **id** from `agy_check`'s
`models` (`gemini-3.7-flash-low`, `claude-sonnet-4-6`), not a display name — agy's own error
message for an unknown model prints display names, which `--model` does not accept. A model
id that `agy_check` has already enumerated as unknown is refused with `model_not_found`
before a job is spent on it.

The model that actually answered is reported as `observedModel`, read off the run's own
`init` event. agy resolves its own model and there is no configuration file to predict it
from, so this plugin never reports an expected model — only an observed one. `effort`
(`low`/`medium`/`high`) is agy's reasoning dial; omit it unless the user asked.

## Budget contract

`timeoutMs` runs 10000..86400000 and defaults to 600000. Lowering it does not make agy
faster; it discards work. A foreground call (`background: false`) is clamped to 240000
because Codex aborts a `tools/call` at 300s, and the clamp is reported in `warnings`.

This plugin publishes **no per-kind wall-time distribution**, because none has been measured
against agy. Judge lateness from `agy_status`: a job whose `lastEventAt` is more than 45
seconds in the past has gone quiet, while a job still emitting events is working however long
it has been running. Do not cancel on elapsed time alone — a job that runs out of budget
keeps its conversation and can be resumed, and a cancelled one cannot.

A run that has emitted under 4000 characters in total, has completed no tool call, and then
goes silent for 45 seconds is ended early as `stalled` rather than being allowed to hold the
whole budget. That is a provider or model hang, and a larger `timeoutMs` will not help it. All
three conditions are required: a run that has produced real output, or has completed even one
tool call, is left alone however long it goes quiet, because a first tool call that is a build
or a test run looks exactly like silence.

`prompt` is bounded because agy takes it as a command-line value with no stdin path. An
oversized prompt is refused with `prompt_too_large` rather than failing inside `spawn`. Note
also that the prompt is visible in `ps` to other processes of the same OS user while a run
is in flight.

## Continuing a conversation

A timeout keeps the conversation, so continue it rather than rerunning the work: read
`agyConversationId` from the job and pass it to `agy_continue`.

Two measured facts change how you read a continuation. **agy does not fail on a conversation
id it cannot find** — it warns, exits 0, and starts a fresh conversation with none of the
earlier context. This plugin compares the id that came back against the one requested and
puts `conversation_not_found` in `warnings`; if you see it, treat the answer as a fresh run.
And **`num_turns` and token usage are cumulative over the conversation**, with wall time
growing steeply as it deepens, so a long resume chain is slower and more expensive than
asking the same question fresh.

## Reading a result

`outputSummary` is the answer plus the evidence for it.

- `resultComplete === true` is the only thing that means agy finished and produced its
  answer. Nothing else counts as done.
- `finalText` is agy's answer. The stdout tail is evidence, not the answer, and widening
  `maxChars` is not how to reach it — use `view: "final"` or read `outputSummary`.
- `finalTextPartial === true` means the text is not a completed answer — whatever the reason.
  It covers a run that answered and then errored, and equally a job that is still running, was
  cancelled, or timed out with text already streamed. Read `state` to tell which. The text is
  worth reading and the run is usually worth resuming.
- `toolCallCount` counts completed tool calls, `filesInspected` counts distinct files opened,
  and `evidenceLevel` grades them: `none` at zero tool calls, `substantive` at five or more
  *and* at least one file inspected, `thin` in between. A review verdict with
  `toolCallCount === 0` is an opinion, not a review: it is never `resultComplete`, and it must
  not be counted as a passing vote.
- `permissionDenied` and `deniedTargets` mean agy could not inspect what it needed. Absence
  of findings is then not evidence of correctness.
- `structuredOutput` is present only when a run was given a JSON schema; it is validated by
  agy itself, so parse it rather than scraping `finalText`.
- `observedModel`, `usage` and `durationSeconds` describe the run that produced all of this.

On the three observing tools, top-level `ok` reflects the **job's** outcome, not the query's:
a successfully-read record of a failed job is `ok: false` with a typed `error.code`.
`terminal: true` means the record is final and polling it again is waste. Prefer a single
blocking `waitMs` over a poll loop, and do not call `agy_status` and `agy_result` at the same
instant — `agy_result` already contains the record.

Job state lives in a private user state directory, survives a restart, and is projected
before it crosses the wire: the resolved binary, the argv, the pids and the log paths stay
inside the plugin. `terminalSummary` keeps the terminal facts on the record so a job stays
diagnosable after its logs are gone.

Never ask agy to commit, push, deploy, clean the worktree, read hidden Codex context, or act
as final owner. Codex verifies every finding against the workspace before acting on it.

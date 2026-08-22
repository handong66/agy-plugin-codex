# Changelog

Notable changes to `agy-plugin-codex`.

## 0.1.0 — 2026-08-20

First release. A Codex MCP adapter for Google's Antigravity CLI (`agy`), sharing its
structure with the sibling plugins `opencode-plugin-codex` and `grok-plugin-codex` and its
measured agy contract with `agy-plugin-cc`.

### Contract

- Ten tools: `agy_check`, `agy_run`, `agy_continue`, `agy_rescue`, `agy_review`,
  `agy_adversarial_review`, `agy_conversations`, `agy_status`, `agy_result`, `agy_cancel`.
- One response envelope for every tool and every failure: `{ ok, error?, warnings, data }`,
  with typed boundary refusals returned rather than thrown, and `retryable` on each one.
- Background by default. Job state lives in a private user state directory, survives a
  restart, and is projected before it crosses the wire — the resolved binary, the argv, the
  pids and the log paths stay inside the plugin.
- `timeoutMs` 10000..86400000, default 600000, clamped to 240000 in the foreground because
  Codex aborts a `tools/call` at 300s.

### Built against measured agy behaviour

Everything in `docs/AGY-RUNTIME-CONTRACT.md` was produced by running agy 1.1.16 and reading
the output; the probe commands are published alongside each claim. Four of those measurements
change the design rather than decorate it:

- **agy ignores the process working directory.** Without `--add-dir` it operates inside
  `~/.gemini/antigravity-cli` and sees none of the repository, so a call with no resolvable
  workspace is refused with `workspace_unavailable` instead of run.
- **A non-existent `--add-dir` is silently ignored** — exit 0, `status: "SUCCESS"`, empty
  stderr, and the work done in agy's own state directory. Nothing in the output distinguishes
  it from a real run, so the workspace path is validated before the spawn.
- **An unknown `--conversation` id starts a fresh conversation**, again with exit 0 and
  success. The id that comes back is compared against the one requested, and a mismatch is
  reported as `conversation_not_found` in `warnings`.
- **agy reports its own outcome independently of its exit code.** A run can exit 0 with
  `status: "ERROR"`, or report `ERROR` while carrying a substantial answer. Outcome
  classification reads the run document, never the exit code alone, and a run that answered
  and then failed is surfaced as `failed_with_partial_text` with its text intact.

  **Correction (2026-08-22, measured against agy 1.1.18):** The exit-0-with-`ERROR` example
  above was not reproducible on agy 1.1.18; all four agy 1.1.18 `ERROR` probes exited 1. In agy
  1.1.18, exit 0 instead covers `SUCCESS`, `CANCELED`, and silent wrong-workspace `SUCCESS`, so
  exit 0 does not establish that the requested work happened.

### Read-only reviews are a filesystem guarantee

The original agy 1.1.16 rationale generalised from probes in which permission-gated tool
calls were denied. **Correction (2026-08-22, measured against agy 1.1.18):**
`request-review` can permit ordinary reads while denying writes, but agy 1.1.18 chooses what
to deny and terminates the run without an answer after a denial. E1 denied a read of `.env`,
and all three runs failed despite an explicit no-shell prompt.

So `agy_review` and `agy_adversarial_review` isolate by workspace instead: agy is handed a
disposable copy of the working tree, built from git's tracked and untracked file list, and is
never told the repository's path. After the run the copy is diffed and the real tree is
fingerprinted, so `readonly_run_wrote_files` names anything the review edited inside the copy
and `tree_changed_during_readonly_run` fires if the real tree moved. Mirror paths are
rewritten back to the repository before any output is persisted.

The corrected agy 1.1.18 rationale leaves that design unchanged: permissions are skipped in
the copy so `request-review` cannot kill a partial review, while the real path is withheld so
repository safety does not depend on agy 1.1.18's permission decisions.

Stated plainly rather than overclaimed: this protects the repository, not the whole
filesystem. The agy 1.1.16 probes observed writes to `~/.gemini/antigravity-cli`. Files git
ignores are absent from the copy, and the review prompt says so, so a missing `node_modules`
is not reported as a finding.

### Evidence and diagnostics

- `outputSummary` carries `resultComplete`, `finalText`, `finalTextPartial`, `toolCallCount`,
  `filesInspected`, `toolNames`, `turnsUsed`, `evidenceLevel`, `permissionDenied`,
  `observedModel`, `usage` and `structuredOutput`.
- Tool calls are counted from agy's `step_type: "tool"` events, **once per call**: agy emits
  each one twice under a single `step_index`, `ACTIVE` then `DONE`, and only `DONE` counts.
- A review verdict with `toolCallCount === 0` is never `resultComplete`; it is an opinion, not
  a review. The rule is deliberately review-only.
- The model that answered is read off the run's `init` event and reported as `observedModel`.
  There is no configuration to scrape and no expected-model machinery, because agy resolves
  its own model.
- A run that emits nothing at all for 45 seconds with no completed tool call is ended early as
  `stalled` rather than holding the whole budget. The threshold sits above the size of agy's
  own `init` event, which is about 1.4 kB because it enumerates 57 tool names.

### Deliberately absent

- **No per-kind wall-time table.** The sibling plugins ship p90 and median figures computed
  from their own recorded jobs; those describe a different CLI and are not restated here. The
  tables are empty, `resolveTimeoutBudget` stays silent for a kind it has no sample for, and
  the published note says what is actually known.
- **No session transfer.** agy has no session-import format, so a Codex thread cannot be
  handed over as one. Inline the relevant context into a prompt instead.
- **No conversation listing from agy's own state.** agy has no `conversations` subcommand,
  its per-conversation state is protobuf inside SQLite with no title or workspace column, and
  the one index file with the right columns is written by the Antigravity desktop app rather
  than the CLI. `agy_conversations` therefore lists the conversations this plugin started,
  from its own job records, and says so.

### Verification

`npm run check` runs typecheck, the esbuild bundle, the full vitest suite, repository plugin
validation, and an MCP schema smoke that needs no agy account. CI runs it on ubuntu-latest and
macos-latest, because the plugin spawns detached workers and signals process groups and that
is exactly where the two platforms differ.

Three further gates need the real CLI and are opt-in. `npm run smoke:agy-cli` checks agy still
has the ten flags this design rests on. `npm run smoke:live-agy` spends real quota to prove
`--add-dir` targets the workspace and a read-only review leaves the repository untouched.
`npm run smoke:live-full` drives all ten tools against a real account — including a resume
onto a conversation id that does not exist, which is the check that proves the
`conversation_not_found` guard fires against the real CLI rather than only against a fixture.
All eleven of its checks pass.

The plugin has also been installed and exercised in a real Codex session; the recorded output
of every gate is in `docs/verification.md`.

# agy for Codex

Ten MCP tools for delegating work to Google's Antigravity CLI (`agy`) from Codex. The
repository README and `plugins/agy-plugin-codex/src/server.ts` are the authority on
behaviour; `skills/agy/SKILL.md` is what a caller should read.

## Contract summary

- One envelope for every response and every failure: `{ ok, error?, warnings, data }`, with
  typed boundary refusals returned rather than thrown.
- `cwd` becomes agy's `--add-dir` and is the whole of what a run can reach. agy ignores the
  process working directory, and a non-existent `--add-dir` fails silently, so the path is
  validated before anything is spawned.
- Runs are write-capable, because agy has no read-only permission mode. The two review tools
  isolate by giving agy a disposable copy of the working tree instead.
- Background by default; state is private, restart-safe, and projected before it crosses the
  wire.
- `timeoutMs` 10000..86400000, default 600000, clamped to 240000 in the foreground.
- Only `outputSummary.resultComplete === true` means agy finished. A review verdict with zero
  tool calls is an opinion, not a review.
- The model that answered is observed from the run, never predicted from configuration.
- Codex remains the final owner of every change.

## Tools

`agy_check`, `agy_run`, `agy_continue`, `agy_rescue`, `agy_review`,
`agy_adversarial_review`, `agy_conversations`, `agy_status`, `agy_result`, `agy_cancel`.

Before a release, run `npm run check` at the repository root.

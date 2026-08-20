# Verification

An evidence ledger, not a how-to. Every entry carries its own date and the CLI version it was
taken against, because a claim about agy's behaviour expires when agy changes.

Last verified on **2026-08-20** against **agy 1.1.16**, Codex CLI 0.144.1, Node 25.9.0,
macOS 26.6.2 (Darwin 25.6.0, arm64).

## Release matrix

Run all of this before announcing a release:

```bash
npm ci
npm run check              # typecheck + bundle + full suite + plugin validation + MCP smoke
npm run test:integration
npm run smoke:agy-cli      # needs the real CLI: the flags this design rests on still exist
npm run smoke:live-agy     # spends real quota: proves --add-dir targets the workspace
git diff --check
```

`npm run check` and `npm run test:integration` need neither the agy binary nor an Antigravity
account: every test drives a fake CLI on `AGY_BIN`, and the MCP smoke asserts the published
schema rather than any model behaviour. That is what lets CI run them on two platforms.

### 0.1.0 — 2026-08-20 (agy 1.1.16, Codex CLI 0.144.1, Node 25.9.0, macOS)

- `npm run check`: typecheck clean, both bundles built (`server.js`, `job-worker.js`),
  **21 test files / 306 tests all passing**, repository plugin validation passed, MCP smoke
  reported `10 tools available`.
- `npm run test:integration`: **3 files, 23 tests, all passing**.
- `npm run smoke:agy-cli` against the real binary: `agy version: 1.1.16`,
  `10 flags present, 14 models reachable`.
- `npm run smoke:live-agy` against a real Antigravity account, in a throwaway git
  repository:

  ```
  agy 1.1.16, 14 models, signedIn=true
  state=succeeded_with_text tools=2 model=gemini-3.7-flash-low
  finalText: "agy-live-smoke-1787213786238"
  review state=succeeded_with_text isolation={"mirrorFileCount":1,"mirrorSkippedCount":0,"warnings":[]}
  live agy smoke passed
  ```

  Reading that line by line: the account is reachable and signed in; a real run came back
  with the sentinel, which it could only have obtained by reading a file inside the workspace
  `--add-dir` gave it; two completed tool calls were counted (not four, which is what counting
  agy's `ACTIVE` emissions as well would have produced); the model is observed rather than
  assumed; a read-only review ran against a one-file disposable copy with no isolation
  warnings; and the final `git status --porcelain` on the repository was empty.
- The MCP smoke earned its place before it ever guarded a regression: on its first run it
  failed `agy_adversarial_review description must say the review runs against a disposable
  copy`. The description had deferred to its sibling tool ("same guarantee as agy_review"),
  which is invisible to a caller reading one tool's schema. Fixed by stating the guarantee in
  full on both tools.

## Runtime contract evidence

`docs/AGY-RUNTIME-CONTRACT.md` is the primary record: sixteen sections, each with the probe
command that produced it, measured against agy 1.1.16 in a throwaway `git init` directory.
Nothing in it is inferred from documentation and nothing is carried over from the sibling
plugins' CLIs.

The recordings those probes produced are checked in under `test/fixtures/` and are what the
parser tests run against, so the stream shapes this plugin believes in are the ones agy
actually emitted:

| Fixture | What it records |
| --- | --- |
| `agy-run-success.jsonl` | A clean stream: `init` (with `permission_mode`), three `step_update`s, `result`. |
| `agy-run-tool-calls.jsonl` | Two tool calls, each emitted twice (`ACTIVE` then `DONE`), plus split `text_delta`s. |
| `agy-permission-denied.json` | The auto-denial, in the plain `json` form, with the reason in `error` and stderr empty. |
| `agy-model-not-found.json` | An unrecognised `--model`: exit 1, empty stderr, empty `conversation_id`, `num_turns` 0. |
| `agy-print-timeout.jsonl` | A timeout that still emits a terminating `result` event and still allocates a conversation id. |
| `agy-answered-then-errored.jsonl` | The case that breaks exit-code logic: real text plus `status: "ERROR"`. |

## Defects found by verification, not by review

- **`rewriteMirrorPaths` corrupted every path on macOS.** `mkdtemp` yields
  `/var/folders/…` while agy reports the resolved `/private/var/folders/…`, and the
  unresolved spelling is a strict prefix of the resolved one. Replacing the short variant
  first rewrote `/private/var/folders/…/mirror/src/a.ts` to `/private<repoRoot>/src/a.ts`, so
  every file a read-only review cited came back on a path that does not exist. Found while
  writing `test/readonly-mirror.test.ts`; fixed by sorting the variants longest-first, and the
  test now holds that ordering in place.
- **A failed `--version` probe was memoised forever.** An explicitly configured `AGY_BIN` is
  trusted once it is executable, and the result was cached even when the version probe had
  failed — so `agy_check` would report a blank version for the rest of the process, long after
  the CLI started answering. Fixed by remembering only a complete answer, which is the
  "successes only" rule every other memo in the plugin already followed.
- **A foreground read-only review pointed agy at the real repository.** `runOrStartJob` used
  the workspace placeholder only on the background path and baked `cwd` into `--add-dir` on
  the synchronous one, so `runForeground`'s substitution was a no-op. `agy_review` with
  `background: false` — a published parameter — therefore ran agy against the live working
  tree with permissions skipped, while still building, diffing and discarding a copy it never
  used. The advertised guarantee was false on a path reachable from the wire. Found by the
  recorded-argv assertion in `test/tools.test.ts`; fixed by using the placeholder on both
  paths, and both `tools.ts` and `job-worker.ts` now refuse to spawn if a placeholder survives
  substitution.
- **A background review outside a git repository lost its typed code.** The worker's catch
  block flattened the `mirror_failed` refusal into `errorClass: "worker_error"` — a class the
  Skill does not publish, so nothing could route on it, and one `isRetryableAgyFailure` calls
  retryable, so the caller was told to retry a call that cannot succeed until the directory
  becomes a git repository. Fixed three ways: the review tools now pre-check for a git
  repository at submit time so the refusal is synchronous and typed, the worker preserves a
  `BoundaryError`'s own code, and `mirror_failed` and `prompt_too_large` joined the
  non-retryable set.
- **A permission denial named only the first word of the command.** agy reports
  `permission check failed for command "cat a.txt"`, and the pattern captured `cat`. That
  sends the reader looking for a problem with a program rather than with a path. Fixed to
  capture the whole quoted command.

## TDD evidence

Regressions observed RED before they were guarded:

- A tool call counted twice, because agy emits `ACTIVE` and `DONE` under one `step_index`.
  Every evidence number — and therefore the "a verdict with zero tool calls is an opinion"
  rule — was doubled until the counter was narrowed to `DONE`.
- The macOS mirror-path corruption above.
- A test whose own `PATH` isolation broke its fake CLI: the fake shelled out to `wc` and `tr`,
  which are not reachable from an empty `PATH`, so its intended failure branch never ran and
  the test passed for the wrong reason. Rewritten to use shell builtins only.

## Read-only isolation

The guarantee is checked three ways rather than asserted:

1. `test/tools.test.ts` runs a real `agy_review` against a real git repository and asserts the
   recorded `--add-dir` is neither the repository nor inside it, that the repository is
   byte-identical afterwards, and that the copy no longer exists when the call returns.
2. At runtime, every mirror job diffs the copy and fingerprints the real tree, so
   `readonly_run_wrote_files` and `tree_changed_during_readonly_run` are observations rather
   than assumptions.
3. `npm run smoke:live-agy` runs a real review against a throwaway repository and fails if
   `git status --porcelain` is non-empty afterwards.

What is deliberately NOT claimed: that agy cannot write anywhere at all. It runs with
permissions skipped and writes to `~/.gemini/antigravity-cli` on every run. The isolation
protects the repository.

## Live smoke

`npm run smoke:live-agy` is the one check a fake cannot stand in for. It creates a throwaway
git repository containing a sentinel string that exists nowhere else, asks agy to read it
through the built MCP server, and fails unless the sentinel comes back — agy could only have
produced it by reading a file inside the workspace it was given. It then runs a read-only
review and fails if the repository is dirty afterwards.

## Not verified

- Concurrency above two simultaneous agy runs, and concurrent runs sharing one workspace.
- Any per-kind wall-time distribution for review-sized work. This is why the budget tables
  ship empty and the published note says only what is known.
- Whether the `ERROR` that accompanied a coerced `--json-schema` was caused by the coercion or
  was transient. One sample, generic message.
- Behaviour on Linux beyond what CI exercises: every runtime measurement above was taken on
  macOS.

## Installed-plugin pickup — run before announcing a release

The one gate this repository cannot run on its own. Install the plugin in a real Codex
session from this checkout and confirm, in order:

1. The ten tools appear.
2. `agy_check` reports the installed agy version and a non-empty model list.
3. `agy_run` in a scratch repository reaches `resultComplete: true`.
4. `agy_review` in that repository returns findings and leaves `git status` clean.
5. `agy_status` on a finished job reports `terminal: true`.

A run that is not recorded here did not happen.

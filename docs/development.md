# Development

This describes the current implementation. Source and tests win if documentation disagrees.

## Responsibility layers

1. **`docs/AGY-RUNTIME-CONTRACT.md`** — what agy actually does, with the probe behind every
   claim. Everything below is built on it. Re-measure before editing it; never edit it from
   reasoning.
2. **`plugins/agy-plugin-codex/src/`** — behaviour.
3. **`test/`** — the behaviour that is guaranteed.
4. **`skills/agy/`** — how a caller should use the tools. Vendored inside the plugin, and
   drift-tested against the source in both directions.
5. **README and these docs** — overview.

The failure mode this ladder exists to prevent is layer 4 quietly describing a plugin that
layer 2 stopped being. `test/skill-contract.test.ts` closes it mechanically.

## Build outputs

`scripts/build.mjs` bundles two entry points with esbuild into
`plugins/agy-plugin-codex/dist/`:

- `server.js` — the MCP server.
- `job-worker.js` — the background worker, a **separate** entry point because it is spawned
  detached and has to outlive the server that started it.

Both are fully bundled (the MCP SDK and zod are inlined), so an installed plugin cache needs
no `node_modules`. `dist/` is a tracked release artifact.

## Runtime flow

Both paths share steps 1-3, which is deliberate: they are the checks that must not be
reachable only from one of them.

1. Resolve and **validate** the workspace: realpath, isDirectory, and inside the Codex
   workspace roots. This is not tidiness — agy silently ignores a `--add-dir` that does not
   exist and reports success, so this is the only place the mistake can be caught.
2. Check the prompt boundary: Codex private paths, and the UTF-8 byte budget.
3. For a review kind, check that `cwd` is a git repository (`listMirrorFiles` returns null
   otherwise). Cheap, and it makes `mirror_failed` a synchronous typed refusal on the
   background path too, instead of a jobId that dies in the worker minutes later.
4. Build the flag vector with `WORKSPACE_PLACEHOLDER` in the `--add-dir` slot — **on both
   paths**, see below.

### Foreground (`background: false`)

5. For a review kind, build the disposable copy and fingerprint the real tree.
6. Substitute the placeholder with the copy's path (or `cwd` for a direct run), put
   `-p <prompt>` on the front, spawn in its own process group.
7. Parse the whole stream, diff the copy, rewrite mirror paths, summarise, clean up the copy
   in a `finally`.

### Background (the default)

5. The flag vector, still carrying the placeholder, is recorded on the job. The prompt is
   written to a `0600` file rather than kept in the record.
6. `JobStore.startAgyJob` spawns `job-worker.js` detached, `stdio: "ignore"`, and returns.
7. The worker reads and **deletes** the prompt file, resolves the workspace (building the copy
   for a review kind), substitutes the placeholder, and spawns agy.
8. It streams stdout line by line through `readStreamProgress`, counting completed tool calls
   and picking up the conversation id and observed model, persisting `lastEventAt` at most
   every 10s and checking the stall rule every 5s.
9. On exit it diffs the copy, fingerprints the real tree, rewrites mirror paths out of the
   logs, and calls `finalizeJobRecord`.
10. The copy is removed in a `finally`, on every path out including the throwing one. If the
    worker throws a **typed** refusal, the record keeps that refusal's own code rather than a
    generic `worker_error` — otherwise the caller gets a class nothing can route on, and one
    that reads as retryable when it is not.

State directory precedence: `AGY_PLUGIN_STATE_DIR`, then `$XDG_STATE_HOME/agy-plugin-codex`,
then `~/.local/state/agy-plugin-codex`. Directories `0700`, files `0600`. Job ids match
`^job_[A-Za-z0-9_-]{1,128}$` and **every path is derived from the validated id**, never
trusted from the record's JSON.

## Environment variables

The plugin reads `AGY_BIN`, `AGY_WORKSPACE_ROOTS`, `AGY_PLUGIN_STATE_DIR`, `XDG_STATE_HOME`,
`CODEX_THREAD_ID`, `CODEX_HOME`, `HOME`, `PATH` and the proxy/TLS variables agy itself obeys.
All of those are allowlisted in `.mcp.json`, and `scripts/validate-plugin.mjs` fails the build
if one of the load-bearing ones goes missing from that list.

One is read and deliberately **not** allowlisted: `AGY_PLUGIN_WORKER_PATH`, which overrides
the path of the background worker. It exists so a test can point the store at a worker other
than the bundled one. Allowlisting it would let a caller's environment choose which executable
the plugin spawns detached, which is a strictly worse trade than making tests set it in the
process they already control. If you add a new variable the plugin reads, decide which of
these two shapes it is before adding it to `.mcp.json`.

## Why the worker owns the mirror

The disposable copy has to live exactly as long as the run. A tool call that built it would
have to either return before the run finished (leaking the copy) or block on a background job
(defeating the point). So the worker builds it, uses it, and removes it, and the tool call
records only the intent (`workspaceMode: "mirror"`) plus the real repository path.

That is also why the argv carries a placeholder rather than a path, and why `toPublicJob`
excludes `args`: the argv names a temp directory that the caller cannot open and that will not
exist by the time they read the record.

The placeholder is used on **both** paths even though a foreground run could resolve its
workspace immediately. It briefly was not, and that was a real defect: `runOrStartJob` baked
`cwd` into `--add-dir` for `background: false`, `runForeground`'s substitution became a no-op,
and a synchronous `agy_review` ran agy against the live working tree while still building and
discarding a copy it never used. One code path, one substitution point, and both `tools.ts`
and `job-worker.ts` now throw rather than spawn if a placeholder survives.

## The record is monotonic

`JobStore.write` refuses a non-terminal write over a terminal record, and preserves a stored
`pid`/`workerPid` when the incoming write has none. Both guard the same race: the worker's
throttled progress write is not awaited by anything, so a write that started before the
terminal record could land after it, put `running` back over a `succeeded` result, and have
the next `status()` call rewrite a completed job as `worker_unavailable`.

A `.cancel` sentinel file is the one status that always wins, checked before and after the
atomic rename.

## agy CLI contract

    agy -p "<prompt>" --output-format stream-json --add-dir "<workspace>" \
        --dangerously-skip-permissions [--mode accept-edits] \
        [--conversation <id>] [--model <id>] [--effort low|medium|high] \
        [--print-timeout <n>s] --disable-slash-commands

`--add-dir` and `--dangerously-skip-permissions` are load-bearing and justified at the call
site in `buildAgyArgs`. `--mode accept-edits` is omitted for a read-only run; `--mode plan` is
never used, because it refuses reads and shell commands too.

`--print-timeout` is set slightly inside the worker's budget so agy gets the chance to write
its own result document — with the conversation id — before the worker signals the group.

## Counting evidence

agy emits every tool call **twice** under one `step_index`: `state: "ACTIVE"` with
`tool_name` and `tool_info.parameters`, then `state: "DONE"` with an added
`tool_info.output`. Only `DONE` is counted, in both the incremental reader and the whole-run
parser. Counting both would double every number that decides whether a review is evidence or
an opinion.

`filesInspected` reads path-shaped keys out of `tool_info.parameters`, which is PascalCase and
differs per tool (`AbsolutePath`, `CommandLine`, …). An unrecognised tool contributes to
`toolCallCount` but not to `filesInspected` — undercounting evidence makes a review look
thinner than it was, which is the safe direction.

## Outcome classification

`exitCode === 0` is not the verdict. The finalizer's branch order is cancellation, stall,
timeout, spawn error, then agy's own `status`/`error` from the run document. A run that exits
0 with `status: "ERROR"` is a failure; a run with `status: "ERROR"` and real text is
`failed_with_partial_text`, with the text preserved and marked partial.

Only real error channels are classified: the process outcome, the run document's `error`
field, and stderr. agy's answer text is never part of the haystack — a review that mentions a
403 is not a 403. The `error` field matters most because an unrecognised `--model` exits 1
with an **empty stderr** and the whole explanation inside the result document.

## Path and prompt boundaries

- `cwd`: absolute, exists, is a directory, inside the Codex workspace roots.
- `prompt`: no Codex private paths unless explicitly allowed; bounded in UTF-8 bytes, because
  agy takes it as a command-line value with no stdin path.
- Review kinds: refused outside a git repository, because the copy is built from git's file
  list and there is no fallback that copies an arbitrary tree.
- Symlinks in the copy: reproduced only when their target stays inside the tree. An absolute
  link or one that climbs out is dropped, because it would be a writable door back into the
  real repository.

`rewriteMirrorPaths` sorts its path variants **longest-first**, and that ordering is
load-bearing rather than tidy. On macOS `mkdtemp` yields `/var/folders/...` while agy reports
the realpath `/private/var/folders/...`, and the short spelling is a strict prefix of the long
one: replacing it first rewrote every cited path to `/private<repoRoot>/...`, which points
nowhere.

## Refreshing an installed plugin

1. `npm run build`
2. Set `plugin.json`'s version to `<release>+codex.<timestamp>` so the installed cache picks
   the rebuild up.
3. Reinstall and exercise it.
4. Drop the cachebuster before tagging — `npm run validate:plugin` refuses it on a tagged
   commit, and so does `test/version-sync.test.ts`.

## TDD and verification

Write the failing test first; the regressions worth having are the ones observed RED. The
core loop:

```bash
npm run typecheck
npx vitest run <file>
npm run validate:plugin   # manifest, .mcp.json allowlist, version gate
npm run smoke:mcp         # the published tool schemas, over real stdio
npm run check             # all of the above plus the full suite
```

Tests drive a fake `agy` on `AGY_BIN` — a throwaway `.mjs` written into a temp directory whose
first line answers `--version`, because discovery probes that before anything else. Both
process-lifetime memos (`resetAgyDiscoveryCache`, `resetCheckCache`) must be reset on entry
and exit, or a remembered binary leaks into the next test. No test in `npm run check` makes a
real model call.

# agy runtime contract — measured, not assumed

Every claim below was produced by running `agy` and reading the output. Probe commands are
given so each one can be re-run. Nothing here is inferred from documentation, and nothing
is carried over by analogy from the OpenCode or Grok CLIs whose plugins this project's
structure comes from.

**Measured against agy 1.1.16 on macOS 26.6.2 (Darwin 25.6.0), arm64, 2026-08-20.**
A first pass against 1.1.15 lives in the sibling project `agy-plugin-cc`; sections marked
*(new in 1.1.16)* were not visible then.

Probes ran in a throwaway `git init` directory, sequentially, with
`--model gemini-3.7-flash-low --print-timeout 90s`.

---

## 1. Invocation

    agy -p "<prompt>" --add-dir "<workspace>" --dangerously-skip-permissions \
        --output-format stream-json --disable-slash-commands

Both `--add-dir` and `--dangerously-skip-permissions` are load-bearing, for two independent
reasons documented in §2 and §3. Dropping either produces a broken run — and in one case a
run that looks perfectly successful while doing nothing you asked for.

## 2. `--add-dir` is MANDATORY. agy does not use the process cwd.

This is the most surprising fact about the runtime and the one most likely to be assumed
away.

Probe (no `--add-dir`, shell cwd contained `a.txt`):

    agy -p 'Does the file a.txt exist in your workspace? Reply with only: the absolute
            path of your workspace root, then YES or NO.' \
        --dangerously-skip-permissions --output-format json

    "response": "/Users/domo/.gemini/antigravity-cli/scratch NO\n"

The agent answered NO and named its workspace inside agy's own state directory. A run
launched from a repository without `--add-dir` cannot see the repository at all.

With `--add-dir "$PWD"`, both file tools and shell commands land in the right place:

    agy -p 'Run the shell command: pwd  and reply with only its output.' --add-dir "$PWD" ...
    "response": "/private/tmp/.../agy-probe\n"

Three distinct fallback paths were observed when the workspace is not set: the agent's
workspace is `~/.gemini/antigravity-cli/scratch`, `run_command`'s shell cwd is
`~/.gemini/antigravity-cli/brain/<conversation_id>`, and default-mode file writes land
directly under `~/.gemini/antigravity-cli/`.

Note a discrepancy worth remembering: the stream's `init` event reports `"cwd"` as the
**spawning shell's** directory even on runs whose agent really operated inside
`~/.gemini/antigravity-cli`. `init.cwd` is NOT a reliable statement of where the agent will
work. Do not use it to verify workspace targeting.

## 3. Without `--dangerously-skip-permissions`, every tool call is auto-denied.

Probe:

    agy -p 'Run: cat a.txt and report the exact contents.' --add-dir "$PWD" --output-format json

    exit 1, stderr EMPTY
    {"conversation_id":"8ad688a0-...","status":"ERROR","response":"",
     "error":"permission check failed for command \"cat a.txt\": user denied permission to
              run command:\ncat a.txt", ...}

Headless mode has no interactive approver, so a permission prompt resolves to *denied* and
the run ends `ERROR` having done nothing. This is not fixable by softer flags: `--sandbox`
and `--mode plan` were both tested and both still auto-deny. There is no allowlist —
`~/.gemini/antigravity-cli/settings.json` holds only `colorScheme` and `trustedWorkspaces`,
and having the repository's ancestor in `trustedWorkspaces` does not grant tool permission.

*(new in 1.1.16)* The stream now corroborates this structurally: `init.permission_mode` reads
`"request-review"` without the flag and `"always-proceed"` with it, so the permission posture
of a run can be asserted from agy's own output instead of inferred from the flags we believe
we passed.

**Consequence:** an agy run that is allowed to READ is, by the same flag, allowed to WRITE.
Read capability and write capability are not separable at the CLI. This drives §6.

## 4. `--mode plan` is not a read-only reviewer. It is a plan generator.

It is tempting to map another CLI's read-only `plan` *agent* onto agy's `--mode plan`. That
mapping is wrong on two counts.

Asked to write two files and run `ls`, plan mode refused all three — including the read and
the shell command — and left the filesystem untouched. Asked to do a pure read of a file
present in the shell cwd, it reported the file missing and named its workspace as
`~/.gemini/antigravity-cli/scratch`. It executes nothing, writes a plan artifact to
`~/.gemini/antigravity-cli/brain/<conversation_id>/plan.md`, and waits for an approval that
never comes in headless mode.

A reviewer that cannot read the diff is not a reviewer. Read-only has to come from workspace
isolation instead — §6.

## 5. Output shapes

`--output-format json` writes exactly one JSON object to stdout:

    {"conversation_id":"564ad8d0-c49c-4a07-93c5-a1d89c3db05c",
     "status":"SUCCESS",
     "response":"OK\n",
     "duration_seconds":3.496646,
     "num_turns":1,
     "usage":{"input_tokens":13746,"output_tokens":1,"thinking_tokens":0,
              "cache_read_tokens":0,"total_tokens":13747}}

On failure, `status` is `"ERROR"` and an `error` string is present. `structured_output` and
`json_schema` appear only with `--json-schema` (§7).

*(new in 1.1.16)* **Exit codes: 0 on `SUCCESS`, 1 on `ERROR`**, observed across every failure
mode probed. That makes the exit code a cheap pre-check — but not the verdict, see below.

`--output-format stream-json` writes NDJSON. Exactly three event names exist: `init`,
`step_update`, `result`. Each line is `{"event":"<name>", ..., "<name>":{...}}` — the payload
key equals the event name. `conversation_id` is a top-level sibling only on `init`; elsewhere
it lives inside the payload.

    {"event":"init","conversation_id":"...","init":{"model":"gemini-3.7-flash-low",
      "cwd":"...","tools":[...57 names...],"permission_mode":"always-proceed"}}
    {"event":"step_update","step_update":{"conversation_id":"...","step_index":0,
      "state":"DONE","step_type":"user_input"}}
    {"event":"step_update","step_update":{...,"step_type":"agent_response",
      "text_delta":"OK\n","duration_seconds":1.19,"usage":{...}}}
    {"event":"result","result":{ <identical to the --output-format json object> }}

- `step_type` values observed: `user_input`, `checkpoint`, `agent_response`, `tool`.
- `state` values observed: `ACTIVE`, `DONE`. Nothing else, including on error and timeout runs.
- `text_delta` is **incremental, not cumulative**: an `ACTIVE` step was observed ending
  mid-word and its `DONE` step continuing from the next character. Concatenating every
  `agent_response.text_delta` in order reproduces `result.response` exactly.
- The `result` event is always the last line and is always present, even on timeout.
- The `init` line is about 1.4 kB on its own because it enumerates 57 tool names. Any
  "has this run produced anything?" threshold has to sit above that.

**`status` and a non-empty `response` are independent.** A run was observed with
`status:"ERROR"` *and* a substantial `response` — the agent answered, then tripped a
permission boundary on a follow-up tool call. Outcome classification must consider both
fields, and must never read `status` or the exit code alone.

## 5a. Tool calls are visible events *(new in 1.1.16)*

    {"event":"step_update","step_update":{...,"step_index":3,"state":"ACTIVE",
      "step_type":"tool","tool_name":"view_file",
      "tool_info":{"name":"view_file","parameters":{"AbsolutePath":".../a.txt"}}}}
    {"event":"step_update","step_update":{...,"step_index":3,"state":"DONE",
      "step_type":"tool","tool_name":"view_file","duration_seconds":0.148394,
      "tool_info":{"name":"view_file","parameters":{"AbsolutePath":".../a.txt"},
                   "output":"1 lines, 9 bytes"}}}

- The discriminator is `step_type == "tool"`. `tool_name` carries the identity.
- **Every call is emitted twice** under one `step_index`: once `ACTIVE`, once `DONE` with an
  added `tool_info.output` summary. Count `state == "DONE"` only, or every tool call doubles.
- `tool_info.parameters` keys are PascalCase and differ per tool: `view_file` uses
  `AbsolutePath`, `run_command` uses `CommandLine`. There is no uniform argument key, and
  there is no free-text tool-summary field on the event.
- No `tool` step is ever emitted without `--dangerously-skip-permissions`, because the run
  dies at the first tool call (§3).

## 6. Read-only reviews: workspace isolation, not a mode flag

Given §3 (read implies write) and §4 (plan mode reads nothing), the only honest way to offer
a read-only review is to make writes land somewhere that does not matter: run agy with
`--add-dir <throwaway copy of the working tree>` instead of the live repository.

What this does and does not guarantee:

- **Guarantees:** the user's working tree and index are untouched, because the real path is
  never given to agy and is not reachable from anything it was told about.
- **Does not guarantee:** that agy cannot write outside any workspace at all. It already
  writes to `~/.gemini/antigravity-cli/` on every run, and `--dangerously-skip-permissions`
  is a blanket approval. The isolation protects the repository, not the whole filesystem.
  Documentation must say this plainly.

A copy, not `git worktree add`: a worktree writes into the user's own `.git/worktrees/` and
leaves it there if the run crashes, checks out committed HEAD (losing exactly the uncommitted
work that is usually the point of the review), and cannot be created in a repository with no
commits yet.

One boundary agy enforces on its own, observed incidentally: reading back a file it had just
written under `~/.gemini/antigravity-cli/` failed with
`Permission denied for read_file(...). Matches hardcoded system protection boundary rule.`
That is agy's rule, not something to rely on.

## 7. `--json-schema` gives native structured output

    agy -p '<prompt>' --json-schema <path-or-json-string> --output-format json

The result object gains `structured_output` (the parsed, schema-conforming object) and
`json_schema` (the schema agy actually parsed). Both the inline-JSON-string and file-path
forms were verified to work.

Two caveats measured on the same runs:

- The model ALSO emitted the JSON inline at the end of `response`, padded with keys not in
  the schema (`toolAction`, `toolSummary`), while `structured_output` itself was clean.
  **Parse `structured_output`; never scrape `response`.**
- *(new in 1.1.16)* A `--json-schema` argument that is neither valid JSON nor a readable path
  is **not rejected**. It is silently coerced into `{"type":"string","description":"<the
  argument>"}`. Comparing the echoed `json_schema` against what was sent is the only way to
  notice.

## 8. Conversations resume, and `num_turns` is cumulative

Three calls on one conversation (`--conversation <id>`, then `-c`) carried context correctly
and returned the same `conversation_id`. Two properties of the returned document change how
budgets must be read:

    call 1: num_turns 1, input_tokens 13.7k, duration  8.5s
    call 2: num_turns 2, input_tokens 27.7k, duration 27.6s
    call 3: num_turns 3, input_tokens 41.9k, duration 46.0s

`num_turns` and `usage` are **cumulative over the conversation, not per invocation**, and
wall time grows steeply with resume depth even for a one-word answer. A deep resume is slower
and more expensive than the same question asked fresh.

`-c/--continue` resolves to the globally most-recent conversation, which is unsafe under
concurrency. Prefer `--conversation <id>`.

## 9. Two silent failures *(new in 1.1.16)*

Only a bad `--model` fails loudly:

    exit 1, stderr EMPTY
    {"conversation_id":"","status":"ERROR","response":"",
     "error":"invalid model selection (--model \"no-such-model-xyz\" --effort \"\"): model
              no-such-model-xyz is not recognized as a known model or custom model in
              settings\nAvailable models:\n  Gemini 3.7 Flash (High)\n  ...", ...}

Note `conversation_id` is the empty string and `num_turns` is 0 — the only observed case of
either. Note also that the error lists **display names** while `--model` accepts **ids**.

The other two are silent and both are integration traps:

**A non-existent `--add-dir` is ignored.** Exit 0, `status: "SUCCESS"`, empty stderr, no
warning of any kind, and the agent runs inside `~/.gemini/antigravity-cli/` instead. Nothing
in the output distinguishes it from a real run. **The workspace path must be validated before
the spawn; there is no post-hoc signal.**

**An unknown `--conversation` id starts a fresh conversation.** agy prints
`warning: conversation "<id>" not found` to stderr — the only non-empty stderr observed in the
entire probe set — then exits 0 with `SUCCESS` and a *different* `conversation_id`. A caller
resuming a lost handle gets a confident answer from a model that has none of the context it
believes it has. **Compare the returned id against the requested one.**

## 10. Timeouts are in-band

`--print-timeout 1s` on a prompt that cannot finish that fast:

    exit 1, stderr EMPTY
    {"conversation_id":"6cd6abb6-...","status":"ERROR","response":"",
     "error":"timeout waiting for response","duration_seconds":0,"num_turns":1,
     "usage":{...all zero...}}

In stream mode the terminating `result` event is still emitted, so a stream parser never has
to special-case a truncated stream. A `conversation_id` is still allocated, so the partial
work is resumable.

## 11. State on disk: no conversation listing is possible

`agy --help` has no `conversations` subcommand. `~/.gemini/antigravity-cli/conversations/`
holds one SQLite triple per conversation (`<uuid>.db`, `-wal`, `-shm`); the tables are
`trajectory_meta`, `steps`, `gen_metadata` and friends, and every payload column is an opaque
protobuf blob — no title, timestamp or workspace column, and the `.db` alone is unreadable
because the content lives in the WAL.

`~/.gemini/antigravity-cli/conversation_summaries.db` *does* have the ideal columns
(`conversation_id`, `title`, `workspace_uris`, `last_modified_time`), but it is written by the
Antigravity desktop app, not the CLI: on the machine measured it held one row from two months
earlier while the CLI was writing conversations that same minute.

**Conclusion: listing past agy conversations is not feasible from agy's own state.** An
integration that needs one has to keep its own registry.

## 12. Machine-readable output is clean ASCII

Every captured stdout and stderr in `json` and `stream-json` mode was scanned for ESC (0x1b)
and for bytes outside tab/newline/carriage-return and printable ASCII: zero hits, no BOM, and
exactly one trailing newline. No de-colourising filter is needed for run output.

Caveat: all probes redirected stdout to a file rather than a TTY, and subcommands are not held
to this — `agy models` prints a human progress line, `Fetching available models...`, before its
`id<TAB>Display Name` rows.

## 13. Concurrency

Two simultaneous print-mode runs both succeeded, with distinct conversation ids, correct
distinct answers, no cross-talk, no lock contention, and durations in line with serial runs.
Behaviour above two concurrent runs, and under a shared workspace, was **not** established.

## 14. Flags and subcommands that matter

    --add-dir <dir>                  repeatable; the ONLY way to set the workspace (§2)
    --dangerously-skip-permissions   required for any tool use at all (§3)
    --output-format text|json|stream-json
    --print-timeout <dur>            e.g. 150s; default 5m0s
    --model <id>                     ids from `agy models`, not display names (§9)
    --effort low|medium|high
    --mode accept-edits|plan         default is neither (§4)
    --conversation <id>              resume; verify the id that comes back (§9)
    -c / --continue                  resume the most recent; unsafe under concurrency (§8)
    --json-schema <path|json>        native structured output (§7)
    --disable-slash-commands         stop a prompt beginning with "/" being reinterpreted
    --agent <name>                   `agy agents` returns EMPTY here; no named agents exist
    --sandbox                        does NOT grant tool permission (§3)

`agy --version` prints a bare version string: `1.1.16`.

Models available from `agy models` at the time of measurement:

    gemini-3.7-flash-{high,medium,low}   gemini-3.6-flash-{high,medium,low}
    gemini-3.5-flash-{high,medium,low}   gemini-3.1-pro-{high,low}
    claude-sonnet-4-6   claude-opus-4-6-thinking   gpt-oss-120b-medium

State lives in `~/.gemini/antigravity-cli/` (`conversations/`, `brain/`, `scratch/`,
`presence/`, `settings.json`, `conversation_summaries.db`).

## 15. Measured wall time — floors only

Trivial prompt, `gemini-3.7-flash-low`, no tools: ~3s.
Single-file read with `--add-dir`:                ~4-6s.
Third turn of a resumed conversation:             ~46s (see §8).
Multi-step run that hit a permission boundary:    ~48s.

These are floor numbers from toy prompts, not review-sized work. **They are deliberately not
turned into a budget**, and this plugin ships empty per-kind latency tables rather than
restating figures measured against a different CLI. Measure real reviews separately before
publishing any distribution.

## 16. What remains unmeasured

- Whether the `ERROR` seen alongside a coerced `--json-schema` (§7) was caused by the coercion
  or was transient. One sample, generic message.
- Concurrency above two simultaneous runs, and concurrent runs sharing one workspace (§13).
- Any per-kind wall-time distribution for review-sized work (§15).

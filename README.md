# agy-plugin-codex

Use Google's [Antigravity CLI](https://antigravity.google) (`agy`) from Codex: delegate a
task, resume a conversation, or get a review that physically cannot touch your repository.

This is a Codex plugin — an MCP server plus a vendored collaboration Skill — and a sibling of
[`opencode-plugin-codex`](https://github.com/handong66/opencode-plugin-codex) and
[`grok-plugin-codex`](https://github.com/handong66/grok-plugin-codex), from which it inherits
its response envelope, its typed refusals, and its restart-safe job store. The agy adapter
itself was written against behaviour measured directly from the CLI, not by analogy with
those two: see [`docs/AGY-RUNTIME-CONTRACT.md`](docs/AGY-RUNTIME-CONTRACT.md), which publishes
the probe command behind every claim.

It lets Codex hand work to Gemini 3.x, Claude Sonnet/Opus 4.6, or GPT-OSS — whichever models
your Antigravity account can reach.

## What makes agy different

Three properties of agy's headless mode shape everything here. An integration built by
analogy with another coding CLI gets all three wrong, and two of them fail *silently*.

**agy cannot see a directory it was not given.** It ignores the process working directory
entirely. Without `--add-dir` it operates inside `~/.gemini/antigravity-cli`, sees none of
your repository, and will create files in its own state directory. Worse, a `--add-dir` that
does not exist is not rejected: the run exits 0, reports `SUCCESS`, writes nothing to stderr,
and does its work in the wrong place. So this plugin validates the workspace path before it
spawns anything, and refuses a call with no resolvable workspace rather than running it.

**agy cannot read without also being able to write.** Headless runs auto-deny every tool call
unless permissions are skipped wholesale. `--sandbox` does not help. `--mode plan` does not
either — it refuses reads and shell commands as well as writes, and works out of a scratch
directory. There is no flag that grants read and withholds write, so a "read-only" review had
to be built a different way (below).

**agy 1.1.18 reports its own outcome independently of its exit code.** In agy 1.1.18, exit 0
covers `SUCCESS`, `CANCELED`, and silent wrong-workspace `SUCCESS`, so exit 0 does not establish
that the requested work happened. Read the structured outcome and evidence, not the exit code,
as the verdict for agy 1.1.18.

## Tools

| Need | Tool |
| --- | --- |
| Is agy installed, signed in, and which models can it reach? | `agy_check` |
| Delegate a task (write-capable in `cwd`) | `agy_run` |
| Carry on a conversation, or resume a timed-out job | `agy_continue` |
| Ask why something is stuck (write-capable, not isolated) | `agy_rescue` |
| Review a target without any risk to the repository | `agy_review` |
| Hunt failure modes without any risk to the repository | `agy_adversarial_review` |
| Find a lost jobId or conversation id | `agy_conversations` |
| Watch, read, or stop a background job | `agy_status`, `agy_result`, `agy_cancel` |

Important parameters and boundaries:

- **`cwd` is the whole of what a run can reach.** It becomes agy's `--add-dir`. It must be
  absolute, must exist, and must sit inside the workspace roots Codex advertises.
- **`background` defaults to true.** A background job survives the call, enforces the full
  `timeoutMs`, and returns a `jobId`. A foreground call is clamped to 240000ms because Codex
  aborts a `tools/call` at 300s.
- **`model` is optional and should usually be omitted.** When you do pass one, pass an id from
  `agy_check` (`gemini-3.7-flash-low`), not a display name — agy's own error message for an
  unknown model prints display names, which `--model` does not accept.
- **`effort`** is `low`/`medium`/`high`, agy's reasoning dial.
- **`conversationId`** resumes. agy does *not* fail on an id it cannot find: it warns, exits
  0, and starts a fresh conversation with none of the earlier context. This plugin compares
  the id that came back and reports `conversation_not_found` in `warnings`. Note also that
  agy's `num_turns` and token usage are cumulative over a conversation, so a long resume chain
  costs more and runs slower than asking the same question fresh.
- **`threatModel`** on the adversarial review labels findings in-model or out-of-model.
  Out-of-model findings are advisory and never blockers.
- **`allowCodexPrivatePaths`** is the only way past the `~/.codex` prompt guard, and it is not
  offered on the two review tools.

Only `data.outputSummary.resultComplete === true` means agy finished and produced its answer.
A verdict with `toolCallCount === 0` is an opinion, not a review, and is never
`resultComplete`. Codex remains the final owner of every change: verify findings against the
workspace before acting on them.

## Read-only reviews are a filesystem guarantee

Because agy cannot separate read permission from write permission, `agy_review` and
`agy_adversarial_review` isolate by *workspace*: agy is handed a disposable copy of the
working tree and is never told the repository's path. Nothing it does can reach your files,
and that is a property of the filesystem rather than a promise about model behaviour.

After the run, the copy is diffed and the real tree is fingerprinted, so
`data.isolation.warnings` can tell you two things a prompt-based "please stay read-only" never
could: `readonly_run_wrote_files` names anything the review edited inside the copy that was
then deleted — so an answer claiming a fix is claiming one that does not exist — and
`tree_changed_during_readonly_run` fires if the real tree moved while an isolated review ran,
which it should not have been able to cause.

Three limits, stated rather than buried:

- The copy is built from git's file list, so these tools need a **git repository** and refuse
  with `mirror_failed` outside one — synchronously, on the submitting call, even in background
  mode. There is no fallback that copies an arbitrary directory.
- **Files git ignores are absent** — `node_modules`, build output, `.env`. The reviewer is
  told this in its own prompt, so it should not report a missing dependency as a finding.
- **This protects the repository, not the whole filesystem.** agy still writes to
  `~/.gemini/antigravity-cli` on every run, and it runs with permissions skipped.

## Result envelope

```jsonc
{
  "ok": true,
  "warnings": [],
  // a few cheap scalars are mirrored here for convenience
  "terminal": true,
  "resumable": true,
  "data": {
    "job": { /* projected record: no argv, no pids, no log paths */ },
    "outputSummary": { "resultComplete": true, "finalText": "...", "toolCallCount": 7 }
  }
}
```

Bulk fields live in `data` and nowhere else. A boundary refusal is the same envelope with
`ok: false` and a typed `error.code` — `workspace_required`, `workspace_unavailable`,
`workspace_out_of_bounds`, `mirror_failed`, `prompt_too_large`, `private_path_blocked`,
`file_attachment_invalid`, `model_not_found`, `cli_not_found`, `cli_probe_timeout`,
`job_not_found`, `state_write_failed` — all `retryable: false` except `cli_probe_timeout`.
The complete table, including every job failure class and every warning that changes how a
result should be read, is in
[`plugins/agy-plugin-codex/skills/agy/references/failure-routing.md`](plugins/agy-plugin-codex/skills/agy/references/failure-routing.md).

## Privacy

Job state lives in `$XDG_STATE_HOME/agy-plugin-codex` (or `~/.local/state/agy-plugin-codex`),
`0700`, with records and logs `0600`. Set `AGY_PLUGIN_STATE_DIR` to move it. Records are
projected before they cross the wire: the resolved binary, the full argv, the pids and the log
paths stay inside the plugin — the argv in particular carries the disposable copy's path.

Every `CODEX_*` environment variable is stripped before agy is spawned, and a prompt naming
`~/.codex` is refused by default. One thing to know rather than discover: agy takes its prompt
as a command-line value with no stdin path, so while a run is in flight the prompt is visible
in `ps` to other processes of the same OS user.

Nothing here contacts any service except through the agy binary itself, which talks to your
own Antigravity account.

## Requirements

- **Antigravity CLI** on `PATH` (`agy --version`). Built and measured against **1.1.16**.
  Set `AGY_BIN` if it lives somewhere unusual.
- **A Google account signed in to agy.** Run `agy` once and complete the browser sign-in. agy
  has no `auth` subcommand, so `agy_check` proves the sign-in by listing models.
- **Node.js 22 or later**, and **git** for the read-only reviews.
- macOS or Linux.

## Configuration

Everything is optional; the plugin works with none of these set.

| Variable | What it does |
| --- | --- |
| `AGY_BIN` | Path to the agy binary, when it is not on `PATH`. An explicitly configured binary is trusted once it is executable. |
| `AGY_WORKSPACE_ROOTS` | `PATH`-separated absolute directories to accept as workspace roots. This is the escape hatch when Codex advertises no roots for a call and you cannot pass an explicit `cwd` — without any root, execution tools refuse, because agy has no process-cwd fallback to land in. |
| `AGY_PLUGIN_STATE_DIR` | Moves the private job state directory. Defaults to `$XDG_STATE_HOME/agy-plugin-codex`, then `~/.local/state/agy-plugin-codex`. |

The proxy and TLS variables agy itself obeys (`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`,
…) are passed through unchanged, and `agy_check` reports which of them are in effect with any
credentials masked.

## Install

```bash
git clone https://github.com/handong66/agy-plugin-codex
cd agy-plugin-codex
npm ci
npm run build
```

Register the checkout as a local marketplace and install from it:

```bash
codex plugin marketplace add "$PWD"
```

```bash
codex plugin add agy-plugin-codex@agy-plugin-codex
```

`codex plugin list` should then show `agy-plugin-codex@agy-plugin-codex  installed, enabled`.
The `npm run build` step is not optional: an installed plugin has no build step of its own, so
Codex runs the bundles in `dist/` directly.

To remove it:

```bash
codex plugin remove agy-plugin-codex@agy-plugin-codex && codex plugin marketplace remove agy-plugin-codex
```

## Development and verification

```bash
npm run check
```

That is typecheck, the esbuild bundle, the full vitest suite, repository plugin validation,
and an MCP schema smoke — none of which needs agy installed or an Antigravity account. CI runs
it on `ubuntu-latest` and `macos-latest`, because the plugin spawns detached workers and
signals process groups, and that is exactly the behaviour that differs between the two.

Three further gates need the real CLI and are opt-in:

```bash
npm run smoke:agy-cli    # the ten agy flags this design rests on still exist
npm run smoke:live-agy   # spends real quota: proves --add-dir targets the workspace
npm run smoke:live-full  # spends real quota: all ten tools against real agy
```

`smoke:live-agy` builds a throwaway git repository with a sentinel file, asks agy to read it,
and fails unless the sentinel comes back — the one check that cannot be faked, because agy
could only have produced that string by reading a file that exists nowhere else. It then runs
a read-only review and fails if `git status` is dirty afterwards.

`smoke:live-full` is the wider pass: all ten tools, including a resume onto a conversation id
that does not exist. agy answers that one with exit 0 and `SUCCESS` from a brand-new
conversation, so it is the check that proves the `conversation_not_found` guard fires against
the real CLI rather than only against a fixture. Recorded output is in
[`docs/verification.md`](docs/verification.md).

`plugin.json`'s version may carry a `+codex.<timestamp>` cachebuster during development, which
is how an installed plugin cache is forced to pick up a rebuild. The release gate refuses it
on any commit a tag points at.

## Documentation authority

1. The source and tests in `plugins/agy-plugin-codex/src` and `test/` define behaviour.
2. [`docs/AGY-RUNTIME-CONTRACT.md`](docs/AGY-RUNTIME-CONTRACT.md) defines what agy does, and
   every claim in it carries the probe that produced it. Re-measure before editing.
3. The vendored Skill and its failure-routing reference define how a caller should use the
   tools. A test fails the build if they and the source disagree in either direction.
4. This README is an overview. Where it disagrees with any of the above, they win.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the lineage this project derives from.
Antigravity and the `agy` CLI are products of Google; this project is not affiliated with,
endorsed by, or supported by Google or OpenAI.

# Privacy

This plugin runs the `agy` binary that is already installed on the machine. It contacts no
service of its own, and everything below happens locally.

## What leaves the machine

Only what you send to agy: the prompt, and whatever agy reads from the workspace directory
you gave it. That goes to your own Antigravity account and is subject to Google's terms for
that product. Nothing is sent anywhere else.

## What is stored locally

Job records and run logs live in `$AGY_PLUGIN_STATE_DIR`, or `$XDG_STATE_HOME/agy-plugin-codex`,
or `~/.local/state/agy-plugin-codex`. Directories are created `0700` and records and logs
`0600`. Records hold the job's kind, status, timings, the workspace path, the conversation id,
the observed model, the terminal outcome, and a bounded preview of the answer. Logs hold agy's
stdout and stderr for that run. Nothing is uploaded, and nothing is deleted for you — remove
the state directory when you want the history gone.

agy keeps its own state in `~/.gemini/antigravity-cli/`, including full conversation
transcripts. That is agy's, not this plugin's, and it is written on every run.

## What is kept away from agy

- Every `CODEX_*` environment variable is removed before agy is spawned.
- A prompt naming a Codex private runtime path such as `~/.codex` is refused by default;
  `allowCodexPrivatePaths` is the explicit override and is not offered on the review tools.
- agy can only read inside the directory passed to `--add-dir`, so paths outside the workspace
  are unreachable regardless.

## What is kept out of responses

Job records are projected before they cross the wire: the resolved binary path, the full argv,
the process ids and the log paths stay inside the plugin. The argv matters here because it
carries the disposable copy's path used by a read-only review. Proxy credentials in
`HTTP(S)_PROXY` are masked in diagnostics. Workspace-source diagnostics report which source
was unusable, never the value it held.

## One thing to know

agy takes its prompt as a command-line value and has no stdin input path. While a run is in
flight, the prompt is therefore visible in `ps` to other processes running as the same
operating-system user. This is a property of the CLI, not a choice this plugin makes.

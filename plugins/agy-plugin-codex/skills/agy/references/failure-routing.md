# Failure routing and polling contract (0.1.0)

This is the complete failure table for `agy-plugin-codex`. It is vendored inside the plugin
rather than kept in the repository README so it can never be a release behind the code that
produces these codes.

`test/skill-contract.test.ts` enforces it in both directions: every code the source can emit
must appear here, and every identifier this document names in backticks must exist in the
source.

## Every response

```
{
  "ok": boolean,
  "error": { "code": string, "message": string, "retryable": boolean, "details"?: unknown },
  "warnings": string[],
  "data": { ... }
}
```

`warnings` is always present and always an array. Cheap scalars are mirrored at the top
level — `background`, `terminal`, `nextAction`, `waited`, `resumable`, `agyConversationId`,
`observedModel`, `errorClass`, `exitCode`, `bin`, `version`, `agyBin`, `workspaceMode`,
`readOnly`, `stdoutTruncated`, `stderrTruncated`, `maxChars`, `maxCharsClamped`, `view`,
`rawOmitted` — while everything bulky lives only in `data`.

## Boundary refusals

Returned, never thrown. All are `retryable: false` except `cli_probe_timeout`.

| code | What to do |
| --- | --- |
| `cli_not_found` | Install the Antigravity CLI (`brew install --cask antigravity-cli`) or set `AGY_BIN` to its path. |
| `cli_probe_timeout` | A binary exists but did not answer `--version` in time. Retry once; if it repeats, the binary is wedged. |
| `workspace_required` | No workspace could be resolved, and agy has no process-cwd fallback. Pass an absolute `cwd`, or set `AGY_WORKSPACE_ROOTS`. |
| `workspace_unavailable` | No trusted root at all, or a root that could not be resolved to a directory. `agy_check` reports which source was missing. |
| `workspace_out_of_bounds` | The `cwd` is outside the Codex workspace roots, or does not exist. Add it to the Codex workspace or pass a `cwd` inside an existing root. |
| `mirror_failed` | A read-only review needs a git repository to copy. Run it inside one, or use `agy_run` if you meant agy to work in the tree itself. |
| `prompt_too_large` | The prompt does not fit in an argv. Shorten it, or put the bulk in files inside the workspace and ask agy to read them. |
| `private_path_blocked` | The prompt names a Codex private runtime path such as `~/.codex`. Inline the instructions instead. `allowCodexPrivatePaths` is the deliberate override. |
| `file_attachment_invalid` | Reserved for attachment validation; agy takes no file attachments today. |
| `model_not_found` | `agy_check` enumerated the account's models and this id is not among them. Use an id, not a display name. |
| `job_not_found` | No record under that id on this machine and state directory. `agy_conversations` lists what can still be resumed. |
| `state_write_failed` | The job record, not agy, failed to write. Free space or fix permissions, or move state with `AGY_PLUGIN_STATE_DIR`. |

## Workspace-source diagnostic codes

These appear inside `agy_check`'s `data.workspaceSources`, never as an envelope `error.code`.
They are deliberately path-free: they say which source was unusable, never what it contained.

| errorCode | Meaning |
| --- | --- |
| `method_not_found` | The client does not implement `roots/list`. |
| `request_timeout` | `roots/list` did not answer in time. |
| `parse_error` | The client's `roots/list` response could not be parsed. |
| `invalid_request` | The client rejected `roots/list` as malformed. |
| `invalid_params` | The client rejected the `roots/list` parameters. |
| `internal_error` | The client failed internally answering `roots/list`. |
| `request_failed` | `roots/list` failed for a reason with no more specific code. |
| `provider_failed` | The roots provider itself threw. |
| `invalid_root_uri` | A root URI could not be parsed or converted to a path. |
| `unsupported_root_protocol` | A root was advertised with a non-`file://` scheme. |
| `invalid_configured_roots` | `AGY_WORKSPACE_ROOTS` was set but held a relative, oversized, or over-long list of paths. |
| `invalid_caller_cwd` | The `cwd` argument was not an absolute path of reasonable length. |

## Job failure classes

`errorClass` on a job record, and `error.code` on `agy_status` / `agy_result` / `agy_cancel`.

| errorClass | Retryable | Route |
| --- | --- | --- |
| `timeout` | yes | Not an error: the budget ran out. The conversation survives — resume it with `agy_continue` and a larger `timeoutMs`. Rerunning discards the work. |
| `stalled` | yes | agy produced nothing at all for the stall window with no completed tool call. A provider or model hang, not slow work; a larger budget will not help. Retry with a lighter explicit model. |
| `terminated` | yes | A signal from outside ended it. Never a statement about the model or the account. |
| `permission_denied` | no | agy auto-denied its own tool calls. This plugin always passes the skip-permissions flag, so a run reporting this was not started by this plugin. |
| `auth_required` | no | agy is not signed in. Run `agy` once in a terminal and complete the Google sign-in. |
| `quota_exhausted` | no | The account's balance or quota is exhausted. Retrying will fail. |
| `model_unauthorized` | no | The account is not authorized for that model. Choose one `agy_check` lists. |
| `model_not_found` | no | agy does not recognise the id. Ids come from `agy_check`; its own error message prints display names. |
| `rate_limited` | yes | Transient. Wait and re-run the same request unchanged. |
| `network_error` | yes | agy could not reach its provider. Check network, proxy and certificates. |
| `provider_error` | yes | A server-side error worth retrying once. If it repeats, switch model rather than rewording. |
| `agy_failed` | yes | agy exited without a usable result and gave a reason this table does not classify. The run document's `error` field is the evidence. |
| `unknown` | yes | Clean exit, empty channels, no result. Rerun with a narrower task. |
| `spawn_error` | yes | The process could not be started at all. |
| `worker_error` | yes | The background worker itself threw. Its message is on the record. |
| `worker_unavailable` | yes | The worker exited without recording a terminal result. The job's outcome is lost; rerun it. |
| `cancelled` | yes | `agy_cancel` ended it. The conversation was abandoned mid-turn. |

## Warnings that change how you read a result

These are strings in `warnings`, not errors. Each one means the result is not what it looks
like.

| Warning marker | Meaning |
| --- | --- |
| `conversation_not_found` | agy could not resume the requested conversation and started a fresh one. It still exits 0 and reports success, so the answer was produced with none of the earlier context. |
| `permission_auto_denied` | agy asked for a permission and, having no approver, denied itself. The run did no work. |
| `protected_path_blocked` | agy refused a path behind its own hardcoded protection boundary. Whatever needed it was skipped. |
| `workspace_not_targeted` | agy reported files missing from the workspace, which is what a run pointed at the wrong directory looks like. |
| `readonly_run_wrote_files` | An isolated review edited files inside the disposable copy, which was then deleted. Nothing reached the repository; if the answer claims a fix, there is none. |
| `tree_changed_during_readonly_run` | The real tree or HEAD moved while an isolated review ran. The review should not have been able to cause this. Check `git status` yourself. |
| `verdict produced with 0 tool calls` | A review that opened nothing. An opinion, not a review; never a passing vote. |

## Which field is the answer

- `data.outputSummary.finalText` — agy's answer.
- `data.outputSummary.resultComplete` — the only field that means it finished.
- `data.outputSummary.finalTextPartial` — text exists but the run then errored.
- `data.outputSummary.structuredOutput` — present only for a schema-constrained run; already
  validated by agy, so parse it rather than scraping the text.
- `data.stdout` / `data.stderr` — evidence tails, not the answer.

## Polling

- Prefer one blocking `waitMs` over a loop. It is clamped to 240000 and says so.
- Do not call `agy_status` and `agy_result` at the same instant; `agy_result` already
  contains the record.
- `terminal: true` means the record is final. Stop.
- Do not cancel on elapsed time. Cancel only when `lastEventAt` is more than 45 seconds
  stale, and prefer letting the budget expire — a timeout keeps the conversation, a cancel
  does not.

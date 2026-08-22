import { agyFailureMessage, classifyAgyFailure, parseAgyRun } from "./agy-cli.js";
import { summarizeAgyOutput, toTerminalSummary, type JobRecord } from "./job-store.js";

/**
 * No-progress watchdog thresholds and predicate.
 *
 * They live here, next to the finalizer that files the result, so the rule can be
 * tested without a 45-second background job: `job-worker.ts` is an executable with
 * a top-level `await main()` and cannot be imported.
 */
export const STALL_TIMEOUT_MS = 45_000;
export const STALL_MAX_STDOUT_CHARS = 4_000;

/**
 * Is this silence a provider hang rather than slow work?
 *
 * Two independent conditions, and a run has to fail both to be killed:
 *
 * - It has produced almost nothing. agy's `init` event alone is about 1.4 kB
 *   because it enumerates 57 tool names, so the floor here has to sit above that:
 *   a run that has emitted only `init` is a run that has done nothing, and if the
 *   threshold were below the size of `init` no run would ever qualify.
 * - It has never completed a tool call. A first tool call that is a build or a test
 *   run stays quiet for far longer than 45 seconds, and killing it would file slow
 *   work as a provider hang -- with guidance saying a larger timeoutMs will not
 *   help, which is exactly wrong for a slow build.
 */
export function isProviderStall(params: {
  silentMs: number;
  stdoutChars: number;
  toolCalls: number;
}): boolean {
  if (params.toolCalls > 0) return false;
  return params.silentMs >= STALL_TIMEOUT_MS && params.stdoutChars < STALL_MAX_STDOUT_CHARS;
}

export type JobOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export type FinalizeJobParams = {
  record: JobRecord;
  stdout: string;
  stderr: string;
  outcome: JobOutcome;
  timedOut: boolean;
  /** The no-progress watchdog ended it: silence with nothing to show for it. */
  stalled?: { silentMs: number };
  cancelRequested: boolean;
  outputTruncated?: boolean;
  finishedAt?: string;
};

/**
 * Decide the terminal shape of a job record.
 *
 * This runs once, at the end of the job, when the whole stream is already in
 * memory. It is deliberately not an incremental parser: a partially written NDJSON
 * line cannot be parsed, while at this point every line is complete.
 *
 * Branch order is cancellation, stall, timeout, spawn error, then agy's own verdict.
 * The last branch is where agy differs from every CLI this design was ported from:
 * `exitCode === 0` is not the verdict. agy reports its own outcome in the result
 * document's `status`, its reason in `error`, and leaves stderr empty -- and a run
 * can carry `status: "ERROR"` together with a substantial answer.
 */
export function finalizeJobRecord(params: FinalizeJobParams): JobRecord {
  const { record, stdout, stderr, outcome } = params;
  const latest: JobRecord = { ...record };
  latest.exitCode = outcome.exitCode;
  latest.signal = outcome.signal;
  if (params.outputTruncated !== undefined) latest.outputTruncated = params.outputTruncated;
  latest.finishedAt = params.finishedAt ?? new Date().toISOString();

  // One parse for the whole job: the conversation handle, the observed model and
  // the event count all come from it. Without this a run that timed out would keep
  // no resume handle at all, because the conversation id is only ever assigned by
  // agy itself.
  const parsed = parseAgyRun(stdout);
  latest.agyConversationId ??= parsed?.conversationId || undefined;
  latest.observedModel ??= parsed?.observedModel;
  const eventCount = Object.values(parsed?.eventCounts ?? {}).reduce((total, count) => total + count, 0);

  // Keep the terminal facts on the record so a job stays diagnosable once its log
  // is gone. The summary is computed against the record as each branch leaves it.
  const persistSummary = (value: JobRecord): JobRecord => {
    value.terminalSummary = toTerminalSummary(summarizeAgyOutput(value, stdout, stderr));
    return value;
  };

  if (latest.status === "cancelled" || latest.cancelRequestedAt || params.cancelRequested) {
    latest.status = "cancelled";
    latest.resumable = Boolean(latest.agyConversationId);
    return persistSummary(latest);
  }

  // A stall is not a spent budget: a run that produced nothing at all for the
  // silence window was never going to finish, and 45s of it costs a whole timeoutMs
  // to discover otherwise.
  if (params.stalled && !params.timedOut) {
    latest.status = "failed";
    latest.errorClass = "stalled";
    latest.resumable = Boolean(latest.agyConversationId);
    latest.errorMessage =
      `agy produced no output for ${Math.round(params.stalled.silentMs / 1_000)}s and had emitted ` +
      `${eventCount} event(s) in total, so the run was ended early instead of holding the ${latest.timeoutMs}ms ` +
      "budget. This looks like a provider or model hang rather than slow work.";
    return persistSummary(latest);
  }

  if (params.timedOut) {
    latest.status = "failed";
    latest.errorClass = "timeout";
    latest.resumable = Boolean(latest.agyConversationId);
    latest.errorMessage = latest.agyConversationId
      ? `agy exceeded timeoutMs=${latest.timeoutMs} after producing ${eventCount} events. ` +
        `The agy conversation ${latest.agyConversationId} is still resumable.`
      : `agy exceeded timeoutMs=${latest.timeoutMs} after producing ${eventCount} events, and no conversation id ` +
        "was observed in its output, so the work cannot be resumed.";
    return persistSummary(latest);
  }

  if (outcome.error) {
    latest.status = "failed";
    latest.errorClass = "spawn_error";
    latest.errorMessage = outcome.error.message;
    return persistSummary(latest);
  }

  // agy's own verdict, which is where the reason for a failure actually lives.
  const runCanceled = parsed?.status === "CANCELED";
  const runErrored = parsed?.status === "ERROR" || runCanceled || Boolean(parsed?.errorText);
  const processFailed = outcome.exitCode !== 0 || Boolean(outcome.signal);
  if (!runErrored && !processFailed) {
    latest.status = "succeeded";
    // A finished conversation is still resumable: agy_continue on it is how a
    // follow-up question keeps the context this run built.
    latest.resumable = Boolean(latest.agyConversationId);
    return persistSummary(latest);
  }

  latest.status = "failed";
  latest.errorClass = runCanceled
    ? "agy_canceled"
    : classifyAgyFailure({
        signal: outcome.signal,
        exitCode: outcome.exitCode,
        stderr,
        errorText: parsed?.errorText
      });
  latest.resumable = Boolean(latest.agyConversationId);
  latest.errorMessage = failureMessage(latest.errorClass, {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stderr,
    errorText: parsed?.errorText
  });
  return persistSummary(latest);
}

/**
 * agy's own words when we have them, our sentence when we do not.
 *
 * agy's `error` field is preferred over stderr because that is where agy puts the
 * reason: measured, an unrecognised `--model` exits 1 with an EMPTY stderr and the
 * whole explanation -- including the list of models the account can reach -- inside
 * the result document.
 */
function failureMessage(
  errorClass: string,
  outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    errorText?: string;
  }
): string {
  const outcomeText =
    outcome.signal !== null
      ? `agy was terminated by ${outcome.signal}.`
      : `agy exited with code ${outcome.exitCode}.`;
  const guidance = agyFailureMessage(errorClass);
  const evidence = (outcome.errorText ?? "").trim() || outcome.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
  const boundedEvidence = evidence.slice(0, 2_000);
  return boundedEvidence ? `${outcomeText} ${guidance} agy reported: ${boundedEvidence}` : `${outcomeText} ${guidance}`;
}

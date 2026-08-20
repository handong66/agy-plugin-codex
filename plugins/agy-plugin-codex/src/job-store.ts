import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agyFailureMessage,
  detectConversationMismatch,
  detectPermissionEvidence,
  discoverAgy,
  discoveryFailure,
  isRetryableAgyFailure,
  parseAgyRun,
  sanitizeAgyEnv
} from "./agy-cli.js";
import { DEFAULT_TIMEOUT_MS } from "./timeout-budget.js";
import { isBoundaryError, jobNotFound, stateWriteFailed } from "./boundary.js";
import type { IsolationWarning } from "./readonly-mirror.js";

export type JobKind = "run" | "continue" | "rescue" | "review" | "adversarial_review";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** A job that has ended. Nothing may put it back to work. */
const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * How the workspace handed to agy was chosen.
 *
 * `direct`  -- agy is given the caller's own directory and may write to it.
 * `mirror`  -- agy is given a throwaway copy built by the worker and is never told
 *              the repository's path. This is how a read-only review is made
 *              read-only, because agy has no read-only permission mode.
 */
export type WorkspaceMode = "direct" | "mirror";

/**
 * The literal argv token the worker replaces with the resolved workspace.
 *
 * A mirror only exists once the worker has built it, which happens after the tool
 * call that recorded the argv has already returned. Rather than have two places
 * build agy's flag vector, the tool builds it once with this placeholder in the
 * `--add-dir` slot and the worker substitutes the real path.
 */
export const WORKSPACE_PLACEHOLDER = "__AGY_WORKSPACE__";

/**
 * A small, durable copy of how the job ended.
 *
 * Logs do not survive indefinitely, and every question worth asking about a
 * finished job -- did it read anything, did it answer, was it denied -- has to
 * remain answerable from the record alone once its log is gone.
 */
export type TerminalSummary = {
  state: JobOutputSummary["state"];
  resultComplete: boolean;
  /** Bounded copy of the answer; the log keeps the full text while it exists. */
  finalTextPreview?: string;
  finalTextTruncated: boolean;
  permissionDenied: boolean;
  deniedTargets: string[];
  toolCallCount: number;
  filesInspected: number;
  turnsUsed: number;
  evidenceLevel: JobOutputSummary["evidenceLevel"];
  observedModel?: string;
};

export type JobRecord = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** The directory the caller asked about. For a mirror job, the real repository. */
  cwd: string;
  command: string;
  args: string[];
  workspaceMode: WorkspaceMode;
  workerPid?: number;
  pid?: number;
  /**
   * agy's own conversation handle, read off the run's stream. This is the resume
   * key for agy_continue, and the reason a timed-out job is worth resuming rather
   * than rerunning.
   */
  agyConversationId?: string;
  /**
   * The conversation the caller asked to resume, kept separately from the one agy
   * actually used. Measured: an unknown id does not fail -- agy warns on stderr,
   * exits 0 and starts a fresh conversation -- so the two must be compared before
   * the answer is believed to carry the earlier context.
   */
  requestedConversationId?: string;
  /**
   * The model that actually answered, read off the run's `init` event. agy resolves
   * its own model and there is no configuration file to predict it from, so this is
   * always observed and never expected.
   */
  observedModel?: string;
  /** What the caller asked for, when it asked for anything. */
  requestedModel?: string;
  requestedEffort?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /**
   * When the worker last saw any output from agy. A caller polling status can then
   * tell "still working" from "silent since", and the no-progress watchdog reads
   * the same clock.
   */
  lastEventAt?: string;
  timeoutMs: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorClass?: string;
  errorMessage?: string;
  /**
   * True when the agy conversation behind this record still holds the work and can
   * be continued with agy_continue.
   */
  resumable?: boolean;
  cancelRequestedAt?: string;
  /** How the job ended, kept on the record so it outlives the job's logs. */
  terminalSummary?: TerminalSummary;
  /**
   * What the read-only isolation observed. Populated by the worker for mirror jobs:
   * whether the run wrote inside the disposable copy, and whether the real tree
   * changed while it ran (which it should not have been able to do).
   */
  isolation?: {
    mirrorFileCount?: number;
    mirrorSkippedCount?: number;
    warnings?: IsolationWarning[];
  };
  outputTruncated?: boolean;
  stdoutPath: string;
  stderrPath: string;
};

/**
 * What a caller is allowed to see of a job record.
 *
 * `command`, `args`, `workerPid`, `pid`, `stdoutPath` and `stderrPath` stay inside
 * the plugin: the worker needs them, the caller does not, and `cwd` is already the
 * caller's own input. The argv in particular carries the disposable mirror's path,
 * which is exactly the thing a read-only review must not hand back.
 */
export type PublicJobRecord = Pick<
  JobRecord,
  | "id"
  | "kind"
  | "status"
  | "cwd"
  | "workspaceMode"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "timeoutMs"
  | "lastEventAt"
  | "agyConversationId"
  | "requestedConversationId"
  | "observedModel"
  | "requestedModel"
  | "requestedEffort"
  | "resumable"
  | "exitCode"
  | "signal"
  | "errorClass"
  | "errorMessage"
  | "cancelRequestedAt"
  | "terminalSummary"
  | "isolation"
  | "outputTruncated"
>;

const PUBLIC_JOB_FIELDS = [
  "id",
  "kind",
  "status",
  "cwd",
  "workspaceMode",
  "createdAt",
  "startedAt",
  "finishedAt",
  "timeoutMs",
  "lastEventAt",
  "agyConversationId",
  "requestedConversationId",
  "observedModel",
  "requestedModel",
  "requestedEffort",
  "resumable",
  "exitCode",
  "signal",
  "errorClass",
  "errorMessage",
  "cancelRequestedAt",
  "terminalSummary",
  "isolation",
  "outputTruncated"
] as const satisfies readonly (keyof PublicJobRecord)[];

/** Project a record for the wire. An allowlist, never a spread. */
export function toPublicJob(record: JobRecord): PublicJobRecord {
  const projected: Record<string, unknown> = {};
  for (const field of PUBLIC_JOB_FIELDS) {
    if (record[field] !== undefined) projected[field] = record[field];
  }
  return projected as PublicJobRecord;
}

export type JobOutputSummary = {
  /**
   * The only field that means "agy finished and produced its answer". Everything
   * else is evidence about the run.
   */
  resultComplete: boolean;
  state:
    | "queued_partial"
    | "running_partial"
    | "cancelled_partial"
    | "failed_partial"
    /**
     * agy exited having written real text and then reported `status: "ERROR"`.
     * Measured: a run answered at length and then tripped a permission boundary on
     * a follow-up tool call. Throwing that answer away would be worse than
     * reporting it as what it is.
     */
    | "failed_with_partial_text"
    | "succeeded_with_text"
    | "succeeded_without_text";
  eventCounts: Record<string, number>;
  agyConversationId?: string;
  /** agy's own verdict on the run: "SUCCESS" or "ERROR". */
  agyStatus?: string;
  lastEventType?: string;
  lastTextPreview?: string;
  /**
   * agy's answer. Present whenever the run produced text, including a run that
   * failed after producing some, so a caller never has to re-parse the log to read
   * what was said. `finalTextPartial` says which case it is.
   */
  finalText?: string;
  finalTextPartial: boolean;
  finalTextTruncated: boolean;
  /**
   * Native structured output, present only when the run was given a JSON schema.
   * Already validated by agy against that schema, so it is parsed rather than
   * scraped out of the answer text.
   */
  structuredOutput?: unknown;
  sawToolUse: boolean;
  /** Completed tool calls. agy emits each call twice; only the DONE half counts. */
  toolCallCount: number;
  /** Distinct file paths agy's tools actually opened. */
  filesInspected: number;
  /** Tool names in call order, deduped and capped: a cheap trace of what it did. */
  toolNames: string[];
  /**
   * agy's own permission posture for the run, from its `init` event. This plugin
   * always passes --dangerously-skip-permissions, which produces "always-proceed";
   * anything else means the run was not launched the way this plugin launches one.
   */
  permissionMode?: string;
  /** Model turns, from agy's own `num_turns` where available. */
  turnsUsed: number;
  usage?: Record<string, number>;
  durationSeconds?: number;
  /** Derived from toolCallCount; `none` means the run did nothing but talk. */
  evidenceLevel: "none" | "thin" | "substantive";
  /** Advisory notes about the run itself, never a reason to hide the output. */
  warnings: string[];
  /**
   * True when agy asked for a permission it did not get. A run can exit 0 and still
   * have inspected nothing, so this must be read before believing an empty finding
   * set.
   */
  permissionDenied: boolean;
  /** What agy was denied, capped so the summary stays small. */
  deniedTargets: string[];
  observedModel?: string;
  errorClass?: string;
  errorMessagePreview?: string;
  guidance: string;
};

/**
 * 'raw' is the full shape (record + stdout/stderr tails + summary). 'final' drops
 * the tails and keeps `outputSummary`, whose `finalText` is where the answer is.
 */
export type JobResultView = "raw" | "final";

export type JobStoreOptions = {
  stateDir?: string;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
};

const WORKER_STARTUP_GRACE_MS = 2_000;
const MAX_RESULT_CHARS = 100_000;
const SUMMARY_READ_CHARS = 1_000_000;
const MAX_DENIED_TARGETS = 5;

/** Budget for the returned final answer. */
const MAX_FINAL_TEXT_CHARS = 32_000;

/** Budget for the copy kept on the record itself, which must stay small. */
const MAX_PERSISTED_FINAL_TEXT_CHARS = 4_000;

/** Below this, a run that did work looks like a glance rather than an inspection. */
const SUBSTANTIVE_TOOL_CALLS = 5;

/** Kinds whose whole value is having looked at something. */
const REVIEW_KINDS = new Set<JobKind>(["review", "adversarial_review"]);

/** Build the durable terminal facts from a finished job's own summary. */
export function toTerminalSummary(summary: JobOutputSummary): TerminalSummary {
  return {
    state: summary.state,
    resultComplete: summary.resultComplete,
    ...(summary.finalText
      ? { finalTextPreview: summary.finalText.slice(0, MAX_PERSISTED_FINAL_TEXT_CHARS) }
      : {}),
    finalTextTruncated:
      summary.finalTextTruncated || (summary.finalText ?? "").length > MAX_PERSISTED_FINAL_TEXT_CHARS,
    permissionDenied: summary.permissionDenied,
    deniedTargets: summary.deniedTargets,
    toolCallCount: summary.toolCallCount,
    filesInspected: summary.filesInspected,
    turnsUsed: summary.turnsUsed,
    evidenceLevel: summary.evidenceLevel,
    ...(summary.observedModel ? { observedModel: summary.observedModel } : {})
  };
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

export function defaultJobStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGY_PLUGIN_STATE_DIR) return resolve(env.AGY_PLUGIN_STATE_DIR);
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(home, ".local", "state");
  return join(stateHome, "agy-plugin-codex");
}

function defaultWorkerPath(env: NodeJS.ProcessEnv): string {
  if (env.AGY_PLUGIN_WORKER_PATH) return resolve(env.AGY_PLUGIN_WORKER_PATH);
  const alongsideBundle = fileURLToPath(new URL("./job-worker.js", import.meta.url));
  if (existsSync(alongsideBundle)) return alongsideBundle;
  return fileURLToPath(new URL("../dist/job-worker.js", import.meta.url));
}

function assertJobId(jobId: string): void {
  if (!/^job_[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new Error("Invalid job ID.");
  }
}

async function readTail(path: string, maxChars: number): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const metadata = await handle.stat();
    const bytesToRead = Math.min(metadata.size, Math.max(maxChars * 4, 4_096));
    if (!bytesToRead) return "";
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, metadata.size - bytesToRead);
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-maxChars);
  } finally {
    await handle.close();
  }
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reduce one agy run to the facts a caller decides on.
 *
 * Two agy-specific rules drive this and neither is guessable from the sibling
 * plugins:
 *
 * 1. `status` and a non-empty `response` are independent. A run can report
 *    `status: "ERROR"` and still carry a substantial answer, so outcome
 *    classification must consider both fields and never `status` alone.
 * 2. The failure reason lives in the run document's `error` field on stdout, with
 *    stderr empty. A classifier that reads only stderr files every real agy failure
 *    as "no recognised reason".
 */
export function summarizeAgyOutput(record: JobRecord, stdout: string, stderr: string): JobOutputSummary {
  const parsed = parseAgyRun(stdout);
  const permissionEvidence = detectPermissionEvidence(stderr, {
    cwd: record.cwd,
    errorText: parsed?.errorText
  });
  const deniedTargets = permissionEvidence
    .filter((item) => item.class !== "workspace_not_targeted")
    .map((item) => item.target);

  const text = parsed?.text ?? "";
  const hasText = text.trim().length > 0;
  const agyStatus = parsed?.status;
  const runErrored = agyStatus === "ERROR" || Boolean(parsed?.errorText);
  const toolCallCount = parsed?.toolCallCount ?? 0;

  let state: JobOutputSummary["state"];
  if (record.status === "cancelled") state = "cancelled_partial";
  else if (record.status === "queued") state = "queued_partial";
  else if (record.status === "running") state = "running_partial";
  else if (record.status === "failed" || runErrored) {
    state = hasText ? "failed_with_partial_text" : "failed_partial";
  } else {
    state = hasText ? "succeeded_with_text" : "succeeded_without_text";
  }

  const filesInspected = parsed?.filesInspected ?? 0;
  const evidenceLevel: JobOutputSummary["evidenceLevel"] =
    toolCallCount === 0
      ? "none"
      : toolCallCount >= SUBSTANTIVE_TOOL_CALLS && filesInspected > 0
        ? "substantive"
        : "thin";

  const warnings: string[] = [];
  // agy exits 0 and reports SUCCESS when it cannot find the conversation it was
  // asked to resume, so this comparison is the only thing standing between a caller
  // and a confident answer produced with none of the context it believes it has.
  const conversationMismatch = detectConversationMismatch({
    requestedConversationId: record.requestedConversationId,
    observedConversationId: parsed?.conversationId,
    stderr
  });
  if (conversationMismatch) warnings.push(conversationMismatch);
  // This plugin always passes --dangerously-skip-permissions, which agy reports as
  // "always-proceed". Any other posture means the run reaching this summary was not
  // launched the way this plugin launches one.
  if (parsed?.permissionMode && parsed.permissionMode !== "always-proceed") {
    warnings.push(
      `agy reported permission_mode "${parsed.permissionMode}" rather than "always-proceed". Headless agy with any ` +
        "other posture auto-denies its own tool calls, so this run could not use tools even if it appeared to try."
    );
  }
  // A review that opened nothing is an opinion. The rule is deliberately not applied
  // to `run` or `continue`, where a short answer with no tool calls can be exactly
  // what was asked for.
  const zeroEvidenceVerdict =
    REVIEW_KINDS.has(record.kind) && state === "succeeded_with_text" && toolCallCount === 0;
  if (zeroEvidenceVerdict) {
    warnings.push("verdict produced with 0 tool calls -- treat as opinion, not review");
  }
  if (parsed && !parsed.sawResultEvent && record.status === "succeeded") {
    warnings.push(
      "agy exited cleanly but never emitted its terminal result event, so the answer here was reassembled from " +
        "streamed text deltas and no conversation id, usage or structured output is available for it."
    );
  }
  for (const item of permissionEvidence) warnings.push(item.message);
  for (const item of record.isolation?.warnings ?? []) warnings.push(item.message);

  const resultComplete = state === "succeeded_with_text" && !zeroEvidenceVerdict;
  const boundedDeniedTargets = deniedTargets.slice(0, MAX_DENIED_TARGETS);

  const errorClass = record.errorClass;
  let guidance: string;
  if (resultComplete) {
    guidance =
      "agy produced final text. Codex must still verify every finding against the workspace before acting on it.";
  } else if (zeroEvidenceVerdict) {
    guidance =
      `agy returned a ${record.kind} verdict without taking a single action, so nothing in the workspace was read. ` +
      "Treat this as an opinion, not a review: do not count it as a passing vote. Rerun with a target it can open, " +
      "and require every finding to cite file:line.";
  } else if (record.status === "running" || record.status === "queued") {
    guidance =
      "agy is still running. Poll agy_status or agy_result with waitMs rather than in a loop; do not treat the " +
      "current stdout as a final answer.";
  } else if (record.status === "cancelled") {
    guidance =
      "agy was cancelled. stdout/stderr are partial logs only, and the conversation was abandoned mid-turn; do not " +
      "treat them as a final answer.";
  } else if (errorClass === "stalled") {
    guidance =
      "agy produced no output at all before the stall window expired, so this is a provider or model hang rather " +
      "than slow work: a larger timeoutMs will not help. Retry with a lighter explicit model (agy_check lists them), " +
      "or check the account, the network, and any HTTP(S)_PROXY in effect.";
  } else if (errorClass === "timeout") {
    const conversationId = record.agyConversationId ?? parsed?.conversationId;
    if (toolCallCount === 0) {
      guidance =
        `agy spent the whole ${record.timeoutMs}ms budget without taking a single action. That is a provider or ` +
        "model hang, not a budget that was too small: raising timeoutMs repeats it. Retry with a lighter explicit " +
        "model, or check the account, the network, and any proxy in effect." +
        // The record still reports resumable:true, because the conversation exists.
        // That is a fact about the handle, not a recommendation: resuming a
        // conversation whose model never answered once will not make it answer now.
        (conversationId
          ? ` The conversation ${conversationId} exists and the record reports it resumable, but resuming a run ` +
            "that produced nothing is unlikely to help -- use it to inspect what happened, not to retry."
          : "");
    } else {
      guidance = conversationId
        ? `agy hit the wall-clock budget after ${toolCallCount} action(s), not an error. Conversation ${conversationId} ` +
          `retains the work. Resume with agy_continue{conversationId:"${conversationId}", prompt:"Continue and ` +
          'produce only the final answer now."} and a larger timeoutMs. Re-verify any file it cites -- the tree may ' +
          "have changed since the pause."
        : `agy hit the wall-clock budget after ${toolCallCount} action(s), not an error, but no conversation id ` +
          "appeared in its output, so there is no resume handle. Rerun with the default timeoutMs of 600000 before " +
          "narrowing the target.";
    }
  } else if (state === "failed_with_partial_text") {
    guidance =
      "agy wrote real text and then reported status ERROR, which is what a run that answers and then trips a " +
      "permission or provider boundary looks like. The text is in finalText and is marked finalTextPartial: treat " +
      "it as an unfinished answer, read errorMessagePreview for what stopped it, and resume the conversation with " +
      "agy_continue rather than starting over.";
  } else if (record.status === "failed") {
    guidance = isRetryableAgyFailure(errorClass)
      ? `${agyFailureMessage(errorClass ?? "unknown")} The run document's error field is the evidence.`
      : // Retrying a quota or authorization failure spends the user's time to reach
        // the same answer; the class is the signal to route elsewhere, not to retry.
        `${agyFailureMessage(errorClass ?? "unknown")} Do not retry this call unchanged.`;
  } else {
    guidance =
      "agy exited successfully but produced no final text. Rerun with a narrower target and an explicit " +
      "answer-only output contract.";
  }

  if (deniedTargets.length) {
    const denial =
      `agy was denied ${deniedTargets.length} permission(s) for ${boundedDeniedTargets.join(", ")}. It could not ` +
      "inspect what it needed, so absence of findings is NOT evidence of correctness.";
    guidance = state === "succeeded_without_text" ? denial : `${denial} ${guidance}`;
  }

  return {
    resultComplete,
    state,
    eventCounts: parsed?.eventCounts ?? {},
    agyConversationId: record.agyConversationId ?? parsed?.conversationId,
    agyStatus,
    lastEventType: parsed?.lastEventType,
    lastTextPreview: hasText ? previewText(text) : undefined,
    finalText: hasText ? text.slice(0, MAX_FINAL_TEXT_CHARS) : undefined,
    finalTextPartial: hasText && state !== "succeeded_with_text",
    finalTextTruncated: hasText && text.length > MAX_FINAL_TEXT_CHARS,
    structuredOutput: parsed?.structuredOutput,
    sawToolUse: toolCallCount > 0,
    toolCallCount,
    filesInspected,
    toolNames: parsed?.toolNames ?? [],
    permissionMode: parsed?.permissionMode,
    turnsUsed: parsed?.turnsUsed ?? 0,
    usage: parsed?.usage,
    durationSeconds: parsed?.durationSeconds,
    evidenceLevel,
    warnings,
    permissionDenied: deniedTargets.length > 0,
    deniedTargets: boundedDeniedTargets,
    observedModel: record.observedModel ?? parsed?.observedModel,
    errorClass,
    errorMessagePreview: parsed?.errorText
      ? previewText(parsed.errorText)
      : record.errorMessage
        ? previewText(record.errorMessage)
        : undefined,
    guidance
  };
}

export class JobStore {
  readonly stateDir: string;
  readonly workerPath: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(options: string | JobStoreOptions = {}) {
    const normalized = typeof options === "string" ? { stateDir: options } : options;
    this.env = { ...process.env, ...(normalized.env ?? {}) };
    this.stateDir = resolve(normalized.stateDir ?? defaultJobStateDir(this.env));
    this.workerPath = normalized.workerPath ?? defaultWorkerPath(this.env);
  }

  private jobsDir(): string {
    return join(this.stateDir, "jobs");
  }

  private jobPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.json`);
  }

  private cancelPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.cancel`);
  }

  private async cancellationTimestamp(jobId: string): Promise<string | undefined> {
    try {
      const value = (await readFile(this.cancelPath(jobId), "utf8")).trim();
      return value || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  stdoutPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.stdout.log`);
  }

  stderrPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.stderr.log`);
  }

  inputPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.input`);
  }

  async ensure(): Promise<void> {
    await mkdir(this.jobsDir(), { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700).catch(() => undefined);
    await chmod(this.jobsDir(), 0o700).catch(() => undefined);
  }

  async write(record: JobRecord): Promise<void> {
    try {
      await this.writeUnguarded(record);
    } catch (error) {
      if (isBoundaryError(error)) throw error;
      throw stateWriteFailed(error, this.stateDir);
    }
  }

  /** The record on disk right now, or undefined if there is no record yet. */
  private async storedRecord(jobId: string): Promise<JobRecord | undefined> {
    try {
      return await this.read(jobId);
    } catch {
      return undefined;
    }
  }

  private async writeUnguarded(record: JobRecord): Promise<void> {
    await this.ensure();
    assertJobId(record.id);
    let normalized: JobRecord = {
      ...record,
      stdoutPath: this.stdoutPath(record.id),
      stderrPath: this.stderrPath(record.id)
    };
    // A job that has ended stays ended. Every writer here does a read-modify-write,
    // and the worker's throttled progress write is not awaited by anything -- so a
    // write that started before the terminal record could land after it and put
    // `running` back on top of a `succeeded` result. The next status() call would
    // then find a running record with a dead workerPid and rewrite it as
    // `worker_unavailable`: a completed result, discarded.
    if (!isTerminalJobStatus(normalized.status)) {
      const stored = await this.storedRecord(record.id);
      if (stored && isTerminalJobStatus(stored.status)) return;
      // The same staleness, one field down. A progress write carries the record as
      // it looked when it was read, and the worker's `record.pid = child.pid` write
      // can land in between -- replaying the snapshot would erase the only direct
      // handle to the detached agy child, which is what agy_cancel signals first.
      if (stored) {
        normalized = {
          ...normalized,
          ...(normalized.pid === undefined && stored.pid !== undefined ? { pid: stored.pid } : {}),
          ...(normalized.workerPid === undefined && stored.workerPid !== undefined
            ? { workerPid: stored.workerPid }
            : {})
        };
      }
    }
    if (normalized.status !== "cancelled") {
      const cancelRequestedAt = await this.cancellationTimestamp(record.id);
      if (cancelRequestedAt) {
        normalized = {
          ...normalized,
          status: "cancelled",
          cancelRequestedAt,
          finishedAt: cancelRequestedAt
        };
      }
    }
    const target = this.jobPath(record.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
    await chmod(target, 0o600);
    if (normalized.status !== "cancelled") {
      const lateCancellation = await this.cancellationTimestamp(record.id);
      if (lateCancellation) {
        await this.write({
          ...normalized,
          status: "cancelled",
          cancelRequestedAt: lateCancellation,
          finishedAt: lateCancellation
        });
      }
    }
  }

  async read(jobId: string): Promise<JobRecord> {
    let raw: string;
    try {
      raw = await readFile(this.jobPath(jobId), "utf8");
    } catch (error) {
      // An unknown or expired id is a typed refusal, not a filesystem accident.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw jobNotFound(jobId);
      throw error;
    }
    const record = JSON.parse(raw) as JobRecord;
    if (record.id !== jobId) throw new Error("Job record ID does not match the requested job ID.");
    return {
      ...record,
      stdoutPath: this.stdoutPath(jobId),
      stderrPath: this.stderrPath(jobId)
    };
  }

  async status(jobId: string): Promise<JobRecord> {
    let record = await this.read(jobId);
    if (!["queued", "running"].includes(record.status)) return record;
    if (record.status === "queued" && !record.workerPid) {
      const createdAtMs = Date.parse(record.createdAt);
      if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= WORKER_STARTUP_GRACE_MS) {
        return record;
      }
    }
    if (isProcessAlive(record.workerPid)) return record;

    await new Promise((done) => setTimeout(done, 25));
    record = await this.read(jobId);
    if (!["queued", "running"].includes(record.status) || isProcessAlive(record.workerPid)) return record;
    record.status = "failed";
    record.errorClass = "worker_unavailable";
    record.errorMessage = "The agy background worker exited without recording a terminal result.";
    record.finishedAt = new Date().toISOString();
    await rm(this.inputPath(jobId), { force: true });
    await this.write(record);
    return record;
  }

  async startAgyJob(params: {
    kind: JobKind;
    cwd: string;
    args: string[];
    prompt: string;
    workspaceMode: WorkspaceMode;
    timeoutMs?: number;
    agyBin?: string;
    requestedConversationId?: string;
    requestedModel?: string;
    requestedEffort?: string;
  }): Promise<JobRecord> {
    await this.ensure();
    const discovered = await discoverAgy({ agyBin: params.agyBin, env: this.env });
    if (!discovered.ok || !discovered.bin) {
      throw discoveryFailure(discovered);
    }
    if (!existsSync(this.workerPath)) {
      throw new Error(`agy background worker not found: ${this.workerPath}. Run the plugin build first.`);
    }

    const id = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const record: JobRecord = {
      id,
      kind: params.kind,
      status: "queued",
      cwd: params.cwd,
      command: discovered.bin,
      args: params.args,
      workspaceMode: params.workspaceMode,
      requestedConversationId: params.requestedConversationId,
      requestedModel: params.requestedModel,
      requestedEffort: params.requestedEffort,
      createdAt: new Date().toISOString(),
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdoutPath: this.stdoutPath(id),
      stderrPath: this.stderrPath(id)
    };
    await this.write(record);
    // The prompt travels through a 0600 file rather than the argv, because agy takes
    // its prompt as a command-line value and a 250,000-character prompt on the
    // command line is both an ARG_MAX risk and visible in `ps` to every local user.
    // The worker reads it, deletes it, and puts it on agy's argv in its own process.
    await writeFile(this.inputPath(id), params.prompt, { mode: 0o600 });
    await chmod(this.inputPath(id), 0o600);

    const worker = spawn(process.execPath, [this.workerPath, id], {
      cwd: params.cwd,
      detached: true,
      stdio: "ignore",
      env: sanitizeAgyEnv({
        ...this.env,
        AGY_PLUGIN_STATE_DIR: this.stateDir
      })
    });
    if (!worker.pid) {
      await rm(this.inputPath(id), { force: true });
      throw new Error("Failed to start the agy background worker.");
    }
    record.workerPid = worker.pid;
    await this.write(record);
    worker.unref();
    return record;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.status(jobId);
    if (isTerminalJobStatus(record.status)) return record;

    const cancelRequestedAt = new Date().toISOString();
    await writeFile(this.cancelPath(jobId), cancelRequestedAt, { mode: 0o600 });
    await chmod(this.cancelPath(jobId), 0o600);
    record.status = "cancelled";
    record.cancelRequestedAt = cancelRequestedAt;
    record.finishedAt = cancelRequestedAt;
    await this.write(record);
    await rm(this.inputPath(jobId), { force: true });
    signalProcessTree(record.pid, "SIGTERM");
    signalProcessTree(record.workerPid, "SIGTERM");
    return record;
  }

  async result(
    jobId: string,
    maxChars = 20_000,
    view: JobResultView = "raw"
  ): Promise<{
    record: JobRecord;
    view: JobResultView;
    rawOmitted?: true;
    stdout?: string;
    stderr?: string;
    maxChars: number;
    maxCharsClamped: boolean;
    outputSummary: JobOutputSummary;
  }> {
    const record = await this.status(jobId);
    const boundedMaxChars = Math.min(Math.max(maxChars, 1), MAX_RESULT_CHARS);
    const [stdout, stderr, summaryStdout, summaryStderr] = await Promise.all([
      readTail(this.stdoutPath(jobId), boundedMaxChars),
      readTail(this.stderrPath(jobId), boundedMaxChars),
      readTail(this.stdoutPath(jobId), SUMMARY_READ_CHARS),
      readTail(this.stderrPath(jobId), SUMMARY_READ_CHARS)
    ]);
    const outputSummary = summarizeAgyOutput(record, summaryStdout, summaryStderr);
    return {
      record,
      view,
      ...(view === "final" ? { rawOmitted: true as const } : { stdout, stderr }),
      // The schema clamps rather than refuses, then says what was used: a caller
      // widening its window should get the tail it asked for, not a protocol error.
      maxChars: boundedMaxChars,
      maxCharsClamped: boundedMaxChars !== maxChars,
      outputSummary
    };
  }
}

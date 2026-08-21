#!/usr/bin/env node
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { readStreamProgress, sanitizeAgyEnv, withPrompt } from "./agy-cli.js";
import { isBoundaryError } from "./boundary.js";
import { finalizeJobRecord, isProviderStall } from "./job-finalize.js";
import { JobStore, WORKSPACE_PLACEHOLDER, type JobRecord } from "./job-store.js";
import {
  compareFingerprints,
  createReadOnlyMirror,
  diffMirrorSnapshots,
  fingerprintTree,
  rewriteMirrorPaths,
  snapshotMirror,
  type IsolationWarning,
  type ReadOnlyMirror,
  type TreeFingerprint
} from "./readonly-mirror.js";

const MAX_CAPTURE_CHARS = 1_000_000;

/**
 * How often the no-progress watchdog re-reads its clock. The rule it applies is
 * `isProviderStall` in job-finalize.ts, where it can be tested without a real
 * 45-second job.
 */
const STALL_CHECK_INTERVAL_MS = 5_000;

/** How often the record's lastEventAt is persisted while a job runs. */
const LAST_EVENT_PERSIST_MS = 10_000;

function appendTail(current: string, chunk: string): { value: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= MAX_CAPTURE_CHARS) return { value: combined, truncated: false };
  return { value: combined.slice(-MAX_CAPTURE_CHARS), truncated: true };
}

function signalTree(child: ChildProcess | null, signal: NodeJS.Signals): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForReadyRecord(store: JobStore, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await store.read(jobId);
    if (record.workerPid || record.status === "cancelled") return record;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`Job ${jobId} did not receive its worker PID.`);
}

async function writeLog(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Resolve the directory this job's `--add-dir` will actually name.
 *
 * For a `direct` job that is the caller's own directory. For a `mirror` job the
 * worker builds a throwaway copy of the working tree here, because agy has no
 * read-only permission mode and the only thing that separates reading from writing
 * is which directory `--add-dir` was given.
 *
 * The path is stat'd before it is used either way. Measured, this is agy's most
 * dangerous silent failure: an `--add-dir` that does not exist is not rejected --
 * agy exits 0, reports SUCCESS, writes nothing to stderr, and quietly runs inside
 * `~/.gemini/antigravity-cli/` instead. Nothing in the output distinguishes that
 * from a real run, so the check has to happen before the spawn.
 */
async function resolveWorkspace(record: JobRecord): Promise<{
  workspace: string;
  mirror?: ReadOnlyMirror;
}> {
  if (record.workspaceMode === "mirror") {
    const mirror = await createReadOnlyMirror(record.cwd);
    return { workspace: mirror.path, mirror };
  }
  const stats = await stat(record.cwd).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(
      `Workspace directory does not exist: ${record.cwd}. agy silently ignores an unusable --add-dir and runs in ` +
        "its own state directory instead, so the run was not started."
    );
  }
  return { workspace: record.cwd };
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("Missing background job ID.");
  const store = new JobStore();
  let record = await waitForReadyRecord(store, jobId);
  if (record.status === "cancelled") {
    await rm(store.inputPath(jobId), { force: true });
    return;
  }

  let child: ChildProcess | null = null;
  let mirror: ReadOnlyMirror | undefined;
  let stdout = "";
  let stderr = "";
  let outputTruncated = false;
  let timedOut = false;
  let cancelRequested = false;
  let toolCallCount = 0;
  let pendingLine = "";
  let lastEventAt = Date.now();
  let lastEventPersistedAt = 0;
  let stalled: { silentMs: number } | undefined;
  let stallTimer: NodeJS.Timeout | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let flushChain = Promise.resolve();
  /** Serialised progress writes, awaited before the terminal record is written. */
  let progressChain = Promise.resolve();

  /**
   * Everything written to a log goes through here.
   *
   * For a mirror job the disposable copy's path appears throughout agy's output --
   * in `init.cwd`, in every `tool_info.parameters.AbsolutePath`, and in the findings
   * themselves. Those are paths the user cannot open and that stop existing when the
   * job ends, so the mirror prefix is rewritten back to the real repository before
   * anything is persisted. Each flush rewrites the whole buffer and overwrites the
   * file, so a partial flush written before the mirror existed cannot survive.
   */
  const presentable = async (value: string): Promise<string> =>
    mirror ? await rewriteMirrorPaths(value, mirror.path, record.cwd) : value;

  const flushLogs = () => {
    const stdoutSnapshot = stdout;
    const stderrSnapshot = stderr;
    flushChain = flushChain.then(async () => {
      await Promise.all([
        writeLog(store.stdoutPath(jobId), await presentable(stdoutSnapshot)),
        writeLog(store.stderrPath(jobId), await presentable(stderrSnapshot))
      ]);
    });
    void flushChain.catch(() => undefined);
    return flushChain;
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushLogs();
    }, 25);
    flushTimer.unref();
  };

  /**
   * Record when output last arrived, throttled: a caller polling status can then
   * tell "still working" from "silent since", and the watchdog reads the same clock.
   *
   * The writes are serialised on one chain and the chain is awaited before the
   * terminal write. Untracked, this read-modify-write could still be in flight when
   * the job finished and would then put `running` back over the terminal record.
   */
  const noteEvent = () => {
    lastEventAt = Date.now();
    if (lastEventAt - lastEventPersistedAt < LAST_EVENT_PERSIST_MS) return;
    lastEventPersistedAt = lastEventAt;
    const at = new Date(lastEventAt).toISOString();
    progressChain = progressChain.then(async () => {
      const stored = await store.read(jobId).catch(() => undefined);
      if (!stored || ["succeeded", "failed", "cancelled"].includes(stored.status)) return;
      stored.lastEventAt = at;
      await store.write(stored).catch(() => undefined);
    });
    void progressChain.catch(() => undefined);
  };

  const requestCancel = () => {
    cancelRequested = true;
    signalTree(child, "SIGTERM");
    forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
    forceKillTimer.unref();
  };
  process.on("SIGTERM", requestCancel);
  process.on("SIGINT", requestCancel);

  let fingerprintBefore: TreeFingerprint | null = null;
  let mirrorBefore: Map<string, string> | null = null;

  try {
    const prompt = await readFile(store.inputPath(jobId), "utf8");
    await rm(store.inputPath(jobId), { force: true });

    const resolved = await resolveWorkspace(record);
    mirror = resolved.mirror;
    if (mirror) {
      // Read afterwards and compared: the real repository's path is never handed to
      // agy, so if these two readings differ the isolation argument is wrong and the
      // user must be told loudly rather than handed a clean-looking verdict.
      fingerprintBefore = await fingerprintTree(record.cwd);
      mirrorBefore = await snapshotMirror(mirror.path);
      record.isolation = {
        mirrorFileCount: mirror.fileCount,
        mirrorSkippedCount: mirror.skipped.length
      };
    }

    // The prompt and the workspace are both substituted here rather than at submit
    // time: the prompt so it never sits in the argv of a process the store spawned,
    // the workspace because a mirror does not exist until this worker builds it.
    const args = record.args.map((arg) =>
      arg === WORKSPACE_PLACEHOLDER ? resolved.workspace : arg
    );
    // A placeholder that survived substitution would be handed to agy as a literal
    // directory name -- and agy does not reject an --add-dir that does not exist, it
    // silently runs inside its own state directory and reports success. Refusing
    // here turns an invisible wrong-workspace run into a job that failed loudly.
    if (args.includes(WORKSPACE_PLACEHOLDER)) {
      throw new Error("Workspace placeholder survived substitution; refusing to run agy.");
    }

    record.status = "running";
    record.startedAt = new Date().toISOString();
    await store.write(record);
    await Promise.all([writeLog(store.stdoutPath(jobId), ""), writeLog(store.stderrPath(jobId), "")]);

    child = spawn(record.command, withPrompt(args, prompt), {
      cwd: record.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizeAgyEnv()
    });
    const outcomePromise = new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolveOutcome) => {
      let settled = false;
      const finish = (value: { exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        resolveOutcome(value);
      };
      child?.on("error", (error) => finish({ exitCode: null, signal: null, error }));
      child?.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    /**
     * Count completed tool calls on complete lines only; a half-written line cannot
     * be parsed. This runs for every job, not only ones with a budget: the watchdog
     * needs to know whether the run has done anything at all, and without the
     * counter it could not tell "hung before doing anything" from "first tool call
     * is a slow build".
     */
    const trackProgress = (chunk: string) => {
      pendingLine += chunk;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        const progress = readStreamProgress(line);
        toolCallCount += progress.toolCalls;
        if (progress.conversationId && !record.agyConversationId) {
          record.agyConversationId = progress.conversationId;
        }
        if (progress.model && !record.observedModel) record.observedModel = progress.model;
      }
    };
    child.stdout?.on("data", (chunk: string) => {
      const appended = appendTail(stdout, chunk);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
      noteEvent();
      trackProgress(chunk);
      scheduleFlush();
    });
    child.stderr?.on("data", (chunk: string) => {
      const appended = appendTail(stderr, chunk);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
      noteEvent();
      scheduleFlush();
    });
    record.pid = child.pid;
    await store.write(record);

    stallTimer = setInterval(() => {
      if (stalled || timedOut || cancelRequested) return;
      const silentMs = Date.now() - lastEventAt;
      if (!isProviderStall({ silentMs, stdoutChars: stdout.length, toolCalls: toolCallCount })) return;
      stalled = { silentMs };
      signalTree(child, "SIGTERM");
      forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, STALL_CHECK_INTERVAL_MS);
    stallTimer.unref();

    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, record.timeoutMs);
    timeout.unref();

    const outcome = await outcomePromise;
    clearTimeout(timeout);
    if (stallTimer) clearInterval(stallTimer);
    stallTimer = undefined;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = undefined;

    const isolationWarnings: IsolationWarning[] = [];
    if (mirror) {
      const wrote = diffMirrorSnapshots(mirrorBefore, await snapshotMirror(mirror.path));
      if (wrote) isolationWarnings.push(wrote);
      const changed = compareFingerprints(fingerprintBefore, await fingerprintTree(record.cwd));
      if (changed) isolationWarnings.push(changed);
      record.isolation = { ...(record.isolation ?? {}), warnings: isolationWarnings };
    }

    if (flushTimer) clearTimeout(flushTimer);
    await flushLogs();
    // Nothing may still be in flight against the record when the terminal write
    // reads it: a pending progress write would otherwise land afterwards.
    await progressChain;
    const stored = await store.read(jobId);
    const latest = finalizeJobRecord({
      record: {
        ...stored,
        agyConversationId: stored.agyConversationId ?? record.agyConversationId,
        observedModel: stored.observedModel ?? record.observedModel,
        ...(record.isolation ? { isolation: record.isolation } : {}),
        lastEventAt: new Date(lastEventAt).toISOString()
      },
      // The finalizer reads the same text the caller will: mirror paths already
      // rewritten, so a persisted terminalSummary never quotes a temp directory.
      stdout: await presentable(stdout),
      stderr: await presentable(stderr),
      outcome,
      timedOut,
      stalled,
      cancelRequested,
      outputTruncated
    });
    await store.write(latest);
  } catch (error) {
    if (stallTimer) clearInterval(stallTimer);
    await progressChain.catch(() => undefined);
    await rm(store.inputPath(jobId), { force: true });
    record = await store.read(jobId).catch(() => record);
    if (record.status !== "cancelled") {
      record.status = "failed";
      // A typed refusal keeps its own code. Flattening a BoundaryError into
      // `worker_error` costs the caller twice: `worker_error` says only that
      // something threw, which is not routable, and it is retryable -- which tells
      // the caller to retry a call that provably cannot succeed until the world
      // changes (a review outside a git repository, say).
      record.errorClass = isBoundaryError(error) ? error.code : "worker_error";
      record.errorMessage = error instanceof Error ? error.message : String(error);
      record.finishedAt = new Date().toISOString();
      await store.write(record).catch(() => undefined);
    }
    throw error;
  } finally {
    // The disposable copy is the whole read-only guarantee, so it is removed on
    // every path out of this worker -- including the throwing one.
    await mirror?.cleanup();
  }
}

await main();

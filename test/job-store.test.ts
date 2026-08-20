import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBoundaryError } from "../plugins/agy-plugin-codex/src/boundary.js";
import {
  JobStore,
  defaultJobStateDir,
  summarizeAgyOutput,
  toPublicJob,
  type JobKind,
  type JobRecord,
  type JobStatus
} from "../plugins/agy-plugin-codex/src/job-store.js";

const tempDirs: string[] = [];
let stateDir: string;
let store: JobStore;

beforeEach(async () => {
  // Kept under the repository (not the OS temp directory) so a state directory this
  // suite creates is always visible to `git status`; afterEach drains them, and the
  // `.agy-plugin-codex-test-` prefix is the one .gitignore is meant to cover.
  stateDir = await mkdtemp(join(process.cwd(), ".agy-plugin-codex-test-"));
  tempDirs.push(stateDir);
  store = new JobStore({ stateDir });
});

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

let idCounter = 0;

function makeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  idCounter += 1;
  const id = overrides.id ?? `job_${Date.now()}_t${idCounter}`;
  return {
    id,
    kind: "run",
    status: "queued",
    cwd: "/tmp/agy-probe",
    command: "/opt/homebrew/bin/agy",
    args: ["--add-dir", "/tmp/agy-review-DISPOSABLE", "-p", "review this"],
    workspaceMode: "direct",
    createdAt: new Date().toISOString(),
    timeoutMs: 600_000,
    stdoutPath: join(stateDir, "jobs", `${id}.stdout.log`),
    stderrPath: join(stateDir, "jobs", `${id}.stderr.log`),
    ...overrides
  };
}

/** A record shaped only for `summarizeAgyOutput`, which reads no files. */
function summaryRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return makeRecord({ status: "succeeded", ...overrides });
}

describe("job ids are validated before the filesystem is ever touched", () => {
  it.each([
    ["job_../../etc/passwd", "a traversal disguised as a job id"],
    ["../x", "a bare relative path"],
    ["job_a/b", "a separator inside an otherwise valid id"],
    ["", "the empty string"]
  ])("rejects %s (%s) from stdoutPath, read and cancel", async (jobId) => {
    expect(() => store.stdoutPath(jobId)).toThrow(/Invalid job ID/);
    expect(() => store.stderrPath(jobId)).toThrow(/Invalid job ID/);
    await expect(store.read(jobId)).rejects.toThrow(/Invalid job ID/);
    await expect(store.cancel(jobId)).rejects.toThrow(/Invalid job ID/);
  });

  it("refuses before creating any state, so a bad id cannot even provoke a mkdir", async () => {
    const fresh = new JobStore({ stateDir: join(stateDir, "never-created") });

    await expect(fresh.read("job_../../etc/passwd")).rejects.toThrow(/Invalid job ID/);

    // The refusal is a validation error, not an ENOENT: nothing under the state
    // directory was opened, created or stat-ed on the way to it.
    expect(existsSync(join(stateDir, "never-created"))).toBe(false);
  });
});

describe("the private state directory is private", () => {
  it("creates the state and jobs directories at 0700 and the record at 0600", async () => {
    const record = makeRecord();
    await store.write(record);

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, "jobs"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, "jobs", `${record.id}.json`))).mode & 0o777).toBe(0o600);
  });

  it("writes the cancellation sentinel at 0600 too, and keeps every log path inside the 0700 jobs directory", async () => {
    const record = makeRecord({ status: "queued" });
    await store.write(record);
    await store.cancel(record.id);

    expect((await stat(join(stateDir, "jobs", `${record.id}.cancel`))).mode & 0o777).toBe(0o600);
    // The stdout/stderr logs are opened by the detached worker, so what this level
    // can guarantee is containment: they can only ever be created inside the 0700
    // jobs directory.
    expect(store.stdoutPath(record.id)).toBe(join(stateDir, "jobs", `${record.id}.stdout.log`));
    expect(store.stderrPath(record.id)).toBe(join(stateDir, "jobs", `${record.id}.stderr.log`));
    expect(store.inputPath(record.id)).toBe(join(stateDir, "jobs", `${record.id}.input`));
  });
});

describe("toPublicJob is an allowlist, because the argv carries the disposable copy's path", () => {
  const mirrorJob = (): JobRecord =>
    makeRecord({
      status: "succeeded",
      workerPid: 4242,
      pid: 4243,
      args: ["--add-dir", "/tmp/agy-review-SECRETMIRROR", "-p", "review this"],
      agyConversationId: "5347faf1-5d39-4a25-8034-502a185fdaf4",
      observedModel: "gemini-3.7-flash-low",
      exitCode: 0
    });

  it("drops command, args, workerPid, pid, stdoutPath and stderrPath", () => {
    const projected = toPublicJob(mirrorJob()) as Record<string, unknown>;

    for (const field of ["command", "args", "workerPid", "pid", "stdoutPath", "stderrPath"]) {
      expect(Object.keys(projected)).not.toContain(field);
    }
  });

  it("keeps the documented public fields", () => {
    const record = mirrorJob();
    const projected = toPublicJob(record) as Record<string, unknown>;

    expect(projected).toMatchObject({
      id: record.id,
      kind: "run",
      status: "succeeded",
      cwd: "/tmp/agy-probe",
      workspaceMode: "direct",
      timeoutMs: 600_000,
      agyConversationId: "5347faf1-5d39-4a25-8034-502a185fdaf4",
      observedModel: "gemini-3.7-flash-low",
      exitCode: 0
    });
  });

  it("lets no value anywhere in the projection carry the mirror path or the binary", () => {
    const serialized = JSON.stringify(toPublicJob(mirrorJob()));

    // A read-only review is isolated by never telling agy the repository path; the
    // reverse must hold too. The mirror path in the argv is the one string that
    // would let a caller open the disposable copy, so it must not reach the wire.
    expect(serialized).not.toContain("agy-review-SECRETMIRROR");
    expect(serialized).not.toContain("/opt/homebrew/bin/agy");
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toContain("4243");
    expect(serialized).not.toContain(".stdout.log");
  });
});

describe("an unknown job id is a typed refusal, not a filesystem accident", () => {
  it("throws job_not_found without naming the state directory", async () => {
    await store.ensure();

    const error = await store.read("job_1700000000000_missing").then(
      () => null,
      (reason: unknown) => reason
    );

    expect(isBoundaryError(error)).toBe(true);
    expect(isBoundaryError(error) && error.code).toBe("job_not_found");
    // This is the one call a caller makes precisely because it lost its handle, so
    // the answer must not leak the absolute path of a private state directory.
    expect((error as Error).message).not.toContain(stateDir);
    expect((error as Error).message).not.toMatch(/ENOENT/);
    expect((error as Error).message).toContain("job_1700000000000_missing");
  });
});

describe("a job that has ended stays ended", () => {
  it("drops a later non-terminal write over a terminal record", async () => {
    const record = makeRecord({ status: "running", workerPid: 4242 });
    await store.write(record);
    await store.write({ ...record, status: "succeeded", exitCode: 0 });

    // The worker's throttled progress write is not awaited by anything, so a write
    // started before the terminal record can land after it. Replaying `running` over
    // `succeeded` would make the next status() call rewrite a completed result as
    // worker_unavailable: a finished answer, discarded.
    await store.write({ ...record, status: "running" });

    const stored = await store.read(record.id);
    expect(stored.status).toBe("succeeded");
    expect(stored.exitCode).toBe(0);
  });

  it.each<JobStatus>(["succeeded", "failed", "cancelled"])(
    "treats %s as terminal for that rule",
    async (terminal) => {
      const record = makeRecord({ status: "queued" });
      await store.write(record);
      await store.write({ ...record, status: terminal });
      await store.write({ ...record, status: "running" });

      expect((await store.read(record.id)).status).toBe(terminal);
    }
  );

  it("does not let a non-terminal write that omits pid or workerPid erase a stored one", async () => {
    const record = makeRecord({ status: "queued", workerPid: 4242, pid: 4243 });
    await store.write(record);

    // A progress write carries the record as it looked when it was read, and the
    // worker's `record.pid = child.pid` write can land in between. Replaying the
    // snapshot would erase the only direct handle to the detached agy child, which
    // is what agy_cancel signals first.
    const stale = makeRecord({ id: record.id, status: "running" });
    delete stale.pid;
    delete stale.workerPid;
    await store.write(stale);

    const stored = await store.read(record.id);
    expect(stored.status).toBe("running");
    expect(stored.pid).toBe(4243);
    expect(stored.workerPid).toBe(4242);
  });
});

describe("the cancellation sentinel outlives the record", () => {
  it("coerces a later terminal write back to cancelled", async () => {
    const record = makeRecord({ status: "queued" });
    await store.write(record);
    const cancelled = await store.cancel(record.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequestedAt).toBeTruthy();

    // The worker may already be mid-flight and file its own terminal result after
    // the cancel. The sentinel on disk, not the record, is what decides.
    await store.write({ ...record, status: "succeeded", exitCode: 0, finishedAt: new Date().toISOString() });

    const stored = await store.read(record.id);
    expect(stored.status).toBe("cancelled");
    expect(stored.cancelRequestedAt).toBe(cancelled.cancelRequestedAt);
    expect(stored.finishedAt).toBe(cancelled.cancelRequestedAt);
  });

  it("also drops a later non-terminal write, and removes the prompt file", async () => {
    const record = makeRecord({ status: "queued" });
    await store.write(record);
    await writeFile(store.inputPath(record.id), "the prompt", { mode: 0o600 });

    await store.cancel(record.id);
    await store.write({ ...record, status: "running" });

    expect((await store.read(record.id)).status).toBe("cancelled");
    expect(existsSync(store.inputPath(record.id))).toBe(false);
  });
});

describe("status() reconciles a record whose worker is gone", () => {
  /** Above macOS's pid_max, so `kill(pid, 0)` can only ever report "no such process". */
  const DEAD_PID = 2_000_000_000;

  it("files a running record with a dead workerPid as failed / worker_unavailable", async () => {
    const record = makeRecord({
      status: "running",
      workerPid: DEAD_PID,
      startedAt: new Date().toISOString()
    });
    await store.write(record);

    const reconciled = await store.status(record.id);

    expect(reconciled.status).toBe("failed");
    expect(reconciled.errorClass).toBe("worker_unavailable");
    expect(reconciled.errorMessage).toBeTruthy();
    expect(reconciled.finishedAt).toBeTruthy();
    expect((await store.read(record.id)).status).toBe("failed");
  });

  it("honours the startup grace for a queued record that has not recorded a workerPid yet", async () => {
    const record = makeRecord({ status: "queued", createdAt: new Date().toISOString() });
    await store.write(record);

    // The worker is spawned after the first record write, so for a short window a
    // queued job legitimately has no workerPid. Reconciling inside that window would
    // fail every job at the moment it was created.
    expect((await store.status(record.id)).status).toBe("queued");
  });

  it("stops honouring the grace once the record is older than the startup window", async () => {
    const record = makeRecord({
      status: "queued",
      createdAt: new Date(Date.now() - 10_000).toISOString()
    });
    await store.write(record);

    const reconciled = await store.status(record.id);
    expect(reconciled.status).toBe("failed");
    expect(reconciled.errorClass).toBe("worker_unavailable");
  });

  it("leaves a terminal record alone", async () => {
    const record = makeRecord({ status: "succeeded", workerPid: DEAD_PID, exitCode: 0 });
    await store.write(record);

    expect((await store.status(record.id)).status).toBe("succeeded");
  });
});

describe("defaultJobStateDir precedence", () => {
  it("puts AGY_PLUGIN_STATE_DIR above XDG_STATE_HOME above $HOME/.local/state", () => {
    const home = "/home/someone";

    expect(
      defaultJobStateDir({ AGY_PLUGIN_STATE_DIR: "/explicit/state", XDG_STATE_HOME: "/xdg", HOME: home })
    ).toBe("/explicit/state");
    expect(defaultJobStateDir({ XDG_STATE_HOME: "/xdg", HOME: home })).toBe(
      join("/xdg", "agy-plugin-codex")
    );
    expect(defaultJobStateDir({ HOME: home })).toBe(join(home, ".local", "state", "agy-plugin-codex"));
  });

  it("reads the same precedence off process.env when no env is passed", () => {
    const saved = {
      AGY_PLUGIN_STATE_DIR: process.env.AGY_PLUGIN_STATE_DIR,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME
    };
    try {
      process.env.XDG_STATE_HOME = "/xdg-from-process-env";
      delete process.env.AGY_PLUGIN_STATE_DIR;
      expect(defaultJobStateDir()).toBe(join("/xdg-from-process-env", "agy-plugin-codex"));

      process.env.AGY_PLUGIN_STATE_DIR = "/explicit-from-process-env";
      expect(defaultJobStateDir()).toBe("/explicit-from-process-env");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("summarizeAgyOutput reduces a real agy run to the facts a caller decides on", () => {
  it("reports a clean run as succeeded_with_text with agy's own answer", () => {
    const summary = summarizeAgyOutput(summaryRecord({ kind: "run" }), fixture("agy-run-success.jsonl"), "");

    expect(summary.state).toBe("succeeded_with_text");
    expect(summary.resultComplete).toBe(true);
    expect(summary.finalText).toBe("OK");
    expect(summary.finalTextPartial).toBe(false);
    expect(summary.toolCallCount).toBe(0);
    expect(summary.evidenceLevel).toBe("none");
    expect(summary.agyStatus).toBe("SUCCESS");
    expect(summary.agyConversationId).toBe("5347faf1-5d39-4a25-8034-502a185fdaf4");
    expect(summary.permissionMode).toBe("always-proceed");
    expect(summary.warnings).toEqual([]);
  });

  it("refuses to call the SAME stdout a complete result when the job was a review", () => {
    const stdout = fixture("agy-run-success.jsonl");

    const asRun = summarizeAgyOutput(summaryRecord({ kind: "run" }), stdout, "");
    const asReview = summarizeAgyOutput(summaryRecord({ kind: "review" }), stdout, "");

    // A review that opened nothing is an opinion. The rule is deliberately review-only:
    // for a `run`, a short answer with no tool calls can be exactly what was asked for,
    // and the identical stdout proves the difference comes from the kind alone.
    expect(asRun.resultComplete).toBe(true);
    expect(asReview.resultComplete).toBe(false);
    expect(asReview.state).toBe("succeeded_with_text");
    expect(asReview.warnings.join(" ")).toContain("verdict produced with 0 tool calls");
    expect(asReview.guidance).toContain("opinion, not a review");
  });

  it.each<JobKind>(["review", "adversarial_review"])(
    "applies the zero-evidence rule to kind=%s",
    (kind) => {
      const summary = summarizeAgyOutput(summaryRecord({ kind }), fixture("agy-run-success.jsonl"), "");
      expect(summary.resultComplete).toBe(false);
    }
  );

  it("counts the DONE half of each tool call once and calls two calls thin evidence", () => {
    const summary = summarizeAgyOutput(
      summaryRecord({ kind: "review" }),
      fixture("agy-run-tool-calls.jsonl"),
      ""
    );

    expect(summary.resultComplete).toBe(true);
    // The fixture emits each tool call twice (ACTIVE then DONE); counting both would
    // double the number that decides whether a review is evidence or an opinion.
    expect(summary.toolCallCount).toBe(2);
    // Only view_file's parameters name a path -- run_command's `CommandLine` is not a
    // file -- so exactly one distinct file was inspected.
    expect(summary.filesInspected).toBe(1);
    expect(summary.toolNames).toEqual(["view_file", "run_command"]);
    // Two calls is below the substantive threshold of five: a glance, not an inspection.
    expect(summary.evidenceLevel).toBe("thin");
    expect(summary.sawToolUse).toBe(true);
  });

  it("keeps the answer of a run that spoke and then reported status ERROR", () => {
    // Measured shape: the failure reason is in the run document's `error` field on
    // stdout and stderr is EMPTY, which is why "" is passed here rather than a tail.
    const summary = summarizeAgyOutput(
      summaryRecord({ status: "failed", kind: "review" }),
      fixture("agy-answered-then-errored.jsonl"),
      ""
    );

    expect(summary.state).toBe("failed_with_partial_text");
    expect(summary.finalText).toBe("calc.py:4 subtracts where it should add.");
    expect(summary.finalTextPartial).toBe(true);
    expect(summary.resultComplete).toBe(false);
    // Throwing the answer away would be worse than reporting it as unfinished.
    expect(summary.guidance).toContain("agy_continue rather than starting over");

    expect(summary.permissionDenied).toBe(true);
    expect(summary.deniedTargets).toContain("/Users/x/.gemini/antigravity-cli/brain/n.txt");
    expect(summary.warnings.join(" ")).toContain("protected_path_blocked");
    expect(summary.errorMessagePreview).toContain("hardcoded system protection boundary rule");
  });

  it("quotes the conversation id of a print-timeout run so the work is not silently lost", () => {
    const stdout = fixture("agy-print-timeout.jsonl");
    const summary = summarizeAgyOutput(
      summaryRecord({
        status: "failed",
        errorClass: "timeout",
        agyConversationId: "ab64fdc8-c0d1-4b7b-974f-2bf5336579e8"
      }),
      stdout,
      ""
    );

    expect(summary.errorClass).toBe("timeout");
    expect(summary.guidance).toContain("ab64fdc8-c0d1-4b7b-974f-2bf5336579e8");
    // agy's own --print-timeout produces a complete result document carrying
    // "timeout waiting for response", duration_seconds 0 and zeroed usage.
    expect(summary.errorMessagePreview).toContain("timeout waiting for response");
    // Zero tool calls means the provider never answered, so this branch deliberately
    // steers to a lighter model rather than to a resume.
    expect(summary.toolCallCount).toBe(0);
    expect(summary.guidance).toContain("without taking a single action");
  });

  it("names agy_continue when a timed-out run had already done work", () => {
    const summary = summarizeAgyOutput(
      summaryRecord({
        status: "failed",
        errorClass: "timeout",
        agyConversationId: "23953eab-a613-4b7a-a647-ae24ec519f38"
      }),
      fixture("agy-run-tool-calls.jsonl"),
      ""
    );

    // A budget that ran out after real work is not an error: the conversation still
    // holds it, and resuming is cheaper than starting over.
    expect(summary.guidance).toContain("agy_continue");
    expect(summary.guidance).toContain("23953eab-a613-4b7a-a647-ae24ec519f38");
  });

  it("warns when the stream reports a different conversation than the one that was asked for", () => {
    const summary = summarizeAgyOutput(
      summaryRecord({
        kind: "continue",
        requestedConversationId: "00000000-0000-4000-8000-000000000000"
      }),
      fixture("agy-run-success.jsonl"),
      ""
    );

    // Measured: an unknown --conversation id does not fail. agy warns on stderr,
    // exits 0, reports SUCCESS and starts a fresh conversation -- so comparing the
    // ids is the only thing standing between a caller and a confident answer
    // produced with none of the context it believes it has.
    const warning = summary.warnings.find((item) => item.includes("conversation_not_found"));
    expect(warning).toBeTruthy();
    expect(warning).toContain("00000000-0000-4000-8000-000000000000");
    expect(warning).toContain("5347faf1-5d39-4a25-8034-502a185fdaf4");
  });
});

describe("result() bounds what it hands back", () => {
  it("clamps maxChars above 100000 and says it clamped", async () => {
    const record = makeRecord({ status: "succeeded", exitCode: 0 });
    await store.write(record);

    const result = await store.result(record.id, 500_000);

    // The schema clamps rather than refuses, then reports what was used: a caller
    // widening its window should get a tail, not a protocol error.
    expect(result.maxChars).toBe(100_000);
    expect(result.maxCharsClamped).toBe(true);
  });

  it("does not report a clamp when the request was already inside the bound", async () => {
    const record = makeRecord({ status: "succeeded", exitCode: 0 });
    await store.write(record);

    const result = await store.result(record.id, 20_000);
    expect(result.maxChars).toBe(20_000);
    expect(result.maxCharsClamped).toBe(false);
  });

  it("omits stdout and stderr entirely under view: final", async () => {
    const record = makeRecord({ status: "succeeded", exitCode: 0 });
    await store.write(record);

    const result = await store.result(record.id, 20_000, "final");

    expect(result.view).toBe("final");
    expect(result.rawOmitted).toBe(true);
    expect("stdout" in result).toBe(false);
    expect("stderr" in result).toBe(false);
    // The answer is still reachable: `final` drops the raw tails, not the summary.
    expect(result.outputSummary).toBeTruthy();
  });
});

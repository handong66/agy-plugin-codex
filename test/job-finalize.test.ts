import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { finalizeJobRecord, type FinalizeJobParams } from "../plugins/agy-plugin-codex/src/job-finalize.js";
import type { JobRecord } from "../plugins/agy-plugin-codex/src/job-store.js";

/**
 * `finalizeJobRecord` is where a job stops being a process and becomes a verdict.
 * Its branch order is cancellation, stall, timeout, spawn error, then agy's own
 * verdict -- and that last branch is where agy differs from every CLI this design
 * was ported from, because `exitCode === 0` is not agy's verdict.
 */

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const SUCCESS = fixture("agy-run-success.jsonl");
const ANSWERED_THEN_ERRORED = fixture("agy-answered-then-errored.jsonl");
const PRINT_TIMEOUT = fixture("agy-print-timeout.jsonl");
const CANCELED = fixture("agy-run-canceled.jsonl");

const SUCCESS_CONVERSATION_ID = "5347faf1-5d39-4a25-8034-502a185fdaf4";
const ERRORED_CONVERSATION_ID = "1f2e3d4c-0000-4000-8000-abcdefabcdef";

function makeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1700000000000_abcd1234",
    kind: "run",
    status: "running",
    cwd: "/tmp/agy-probe",
    command: "/opt/homebrew/bin/agy",
    args: ["--add-dir", "/tmp/agy-probe", "-p", "hello"],
    workspaceMode: "direct",
    createdAt: new Date(Date.now() - 5_000).toISOString(),
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    timeoutMs: 600_000,
    stdoutPath: "/dev/null",
    stderrPath: "/dev/null",
    ...overrides
  };
}

/** Everything `finalizeJobRecord` takes, with the record itself given field by field. */
type FinalizeOverrides = Omit<Partial<FinalizeJobParams>, "record"> & { record?: Partial<JobRecord> };

function finalize(overrides: FinalizeOverrides = {}): JobRecord {
  const { record, ...rest } = overrides;
  return finalizeJobRecord({
    stdout: SUCCESS,
    stderr: "",
    outcome: { exitCode: 0, signal: null },
    timedOut: false,
    cancelRequested: false,
    ...rest,
    record: makeRecord(record)
  });
}

describe("cancellation outranks every other branch", () => {
  it("files a cancelled job as cancelled even when the budget also ran out", () => {
    const finalized = finalize({ cancelRequested: true, timedOut: true, stalled: { silentMs: 60_000 } });

    expect(finalized.status).toBe("cancelled");
    // A cancelled job must never be reported as a timeout or a stall: the user
    // asked for it, and neither class describes what happened.
    expect(finalized.errorClass).toBeUndefined();
    // The conversation was abandoned mid-turn but still exists, so it can be picked
    // up again if the cancellation turns out to have been a mistake.
    expect(finalized.resumable).toBe(true);
    expect(finalized.agyConversationId).toBe(SUCCESS_CONVERSATION_ID);
  });

  it("honours a record that was already marked cancelled, or that carries a cancel timestamp", () => {
    expect(finalize({ record: { status: "cancelled" } }).status).toBe("cancelled");
    expect(finalize({ record: { cancelRequestedAt: new Date().toISOString() } }).status).toBe("cancelled");
  });
});

describe("a stall is not a spent budget", () => {
  it("ends the run early rather than holding the whole timeoutMs", () => {
    const finalized = finalize({
      stdout: "",
      stalled: { silentMs: 46_000 },
      timedOut: false,
      outcome: { exitCode: null, signal: "SIGTERM" }
    });

    expect(finalized.status).toBe("failed");
    expect(finalized.errorClass).toBe("stalled");
    // 45s of silence with nothing to show for it costs a whole timeoutMs to
    // discover otherwise, so the message has to say the run was cut short and why.
    expect(finalized.errorMessage).toContain("ended early instead of holding the 600000ms budget");
    expect(finalized.errorMessage).toContain("46s");
    expect(finalized.errorMessage).toContain("provider or model hang rather than slow work");
  });

  it("yields to the timeout branch when the budget also expired", () => {
    const finalized = finalize({ stalled: { silentMs: 46_000 }, timedOut: true });
    expect(finalized.errorClass).toBe("timeout");
  });
});

describe("a timeout keeps whatever resume handle agy allocated", () => {
  it("is resumable, and says so, when a conversation id appeared in the stream", () => {
    const finalized = finalize({ timedOut: true });

    expect(finalized.status).toBe("failed");
    expect(finalized.errorClass).toBe("timeout");
    expect(finalized.resumable).toBe(true);
    expect(finalized.agyConversationId).toBe(SUCCESS_CONVERSATION_ID);
    expect(finalized.errorMessage).toContain(`conversation ${SUCCESS_CONVERSATION_ID} is still resumable`);
  });

  it("is not resumable, and says so differently, when no conversation id was ever observed", () => {
    const finalized = finalize({ timedOut: true, stdout: "" });

    expect(finalized.errorClass).toBe("timeout");
    expect(finalized.resumable).toBe(false);
    expect(finalized.agyConversationId).toBeUndefined();
    expect(finalized.errorMessage).toContain("cannot be resumed");
    expect(finalized.errorMessage).not.toContain("still resumable");
  });
});

describe("a spawn failure is about this machine, not about agy", () => {
  it("classifies it as spawn_error and keeps the underlying message", () => {
    const finalized = finalize({
      stdout: "",
      outcome: { exitCode: null, signal: null, error: new Error("spawn agy ENOENT") }
    });

    expect(finalized.status).toBe("failed");
    expect(finalized.errorClass).toBe("spawn_error");
    expect(finalized.errorMessage).toBe("spawn agy ENOENT");
  });
});

describe("exit code 0 is not agy's verdict", () => {
  it("fails a measured agy 1.1.18 CANCELED run with exit 0, no error text, and an empty response", () => {
    const finalized = finalize({
      stdout: CANCELED,
      stderr: "",
      outcome: { exitCode: 0, signal: null }
    });

    expect(finalized.status).toBe("failed");
    expect(finalized.exitCode).toBe(0);
    expect(finalized.errorClass).toBe("agy_canceled");
    expect(finalized.errorMessage).toContain("agy exited with code 0.");
    expect(finalized.terminalSummary?.state).toBe("failed_partial");
    expect(finalized.terminalSummary?.resultComplete).toBe(false);
    expect(finalized.terminalSummary?.finalTextPreview).toBeUndefined();
  });

  it("fails a run that exited 0 while its own result document said status ERROR", () => {
    // Measured on agy 1.1.16: agy 1.1.16 reported its own outcome in the result
    // document's `status`, its reason in `error`, and left stderr EMPTY. The agy
    // 1.1.18 re-probe did not reproduce this exit-0/ERROR pairing; the assertion
    // below still guards the plugin terminal-status decision at
    // `plugins/agy-plugin-codex/src/job-finalize.ts:133` rather than claiming
    // current agy 1.1.18 behaviour.
    const finalized = finalize({
      stdout: ANSWERED_THEN_ERRORED,
      stderr: "",
      outcome: { exitCode: 0, signal: null }
    });

    expect(finalized.status).toBe("failed");
    expect(finalized.exitCode).toBe(0);
    // The class is derived from the run document's `error` text, which is the only
    // evidence channel a headless agy failure leaves behind.
    expect(finalized.errorClass).toBe("agy_failed");
    expect(finalized.errorMessage).toContain("agy exited with code 0.");
    // agy's own words, quoted rather than paraphrased.
    expect(finalized.errorMessage).toContain(
      "agy reported: Permission denied for read_file(/Users/x/.gemini/antigravity-cli/brain/n.txt)"
    );
    expect(finalized.errorMessage).toContain("hardcoded system protection boundary rule");

    // The answer it produced before tripping the boundary is not thrown away.
    expect(finalized.terminalSummary?.state).toBe("failed_with_partial_text");
    expect(finalized.terminalSummary?.finalTextPreview).toBe("calc.py:4 subtracts where it should add.");
    expect(finalized.terminalSummary?.resultComplete).toBe(false);
  });

  it("takes the class from agy's error text when that text names a recognised failure", () => {
    // agy's own --print-timeout: exit 1, empty stderr, and a complete result
    // document carrying "timeout waiting for response".
    const finalized = finalize({
      stdout: PRINT_TIMEOUT,
      stderr: "",
      timedOut: false,
      outcome: { exitCode: 1, signal: null }
    });

    expect(finalized.status).toBe("failed");
    expect(finalized.errorClass).toBe("timeout");
    expect(finalized.errorMessage).toContain("agy reported: timeout waiting for response");
  });

  it("succeeds a run that exited 0 with status SUCCESS, and leaves the conversation continuable", () => {
    const finalized = finalize({ stdout: SUCCESS, outcome: { exitCode: 0, signal: null } });

    expect(finalized.status).toBe("succeeded");
    expect(finalized.errorClass).toBeUndefined();
    expect(finalized.errorMessage).toBeUndefined();
    // A finished conversation is still resumable: agy_continue on it is how a
    // follow-up question keeps the context this run built.
    expect(finalized.resumable).toBe(true);
    expect(finalized.terminalSummary?.state).toBe("succeeded_with_text");
    expect(finalized.terminalSummary?.resultComplete).toBe(true);
  });

  it("fails a run the process itself lost, even with no agy verdict at all", () => {
    const finalized = finalize({ stdout: "", outcome: { exitCode: null, signal: "SIGKILL" } });

    expect(finalized.status).toBe("failed");
    // A non-null signal means something outside agy ended it. That is never a
    // statement about the model or the account.
    expect(finalized.errorClass).toBe("terminated");
  });
});

describe("the conversation handle and the observed model survive the failure branches", () => {
  const branches: Array<[string, FinalizeOverrides]> = [
    ["cancelled", { cancelRequested: true }],
    ["stalled", { stalled: { silentMs: 46_000 } }],
    ["timeout", { timedOut: true }],
    ["agy verdict", { stdout: ANSWERED_THEN_ERRORED, outcome: { exitCode: 0, signal: null } }]
  ];

  it.each(branches)("recovers them on the %s branch", (name, overrides) => {
    const finalized = finalize(overrides);

    // The conversation id is only ever assigned by agy itself, so a run that ended
    // badly would keep no resume handle at all without this recovery.
    expect(finalized.agyConversationId).toBe(
      name === "agy verdict" ? ERRORED_CONVERSATION_ID : SUCCESS_CONVERSATION_ID
    );
    expect(finalized.observedModel).toBe(name === "agy verdict" ? "claude-sonnet-4-6" : "gemini-3.7-flash-low");
  });

  it("does not overwrite a conversation id the record already carried", () => {
    const finalized = finalize({
      record: { agyConversationId: "already-known", observedModel: "already-observed" },
      timedOut: true
    });

    expect(finalized.agyConversationId).toBe("already-known");
    expect(finalized.observedModel).toBe("already-observed");
  });
});

describe("every failing branch stays diagnosable once the logs are gone", () => {
  const failing: Array<[string, FinalizeOverrides]> = [
    ["stalled", { stdout: "", stalled: { silentMs: 46_000 } }],
    ["timeout with a handle", { timedOut: true }],
    ["timeout without a handle", { stdout: "", timedOut: true }],
    ["spawn error", { stdout: "", outcome: { exitCode: null, signal: null, error: new Error("EACCES") } }],
    ["agy verdict", { stdout: ANSWERED_THEN_ERRORED, outcome: { exitCode: 0, signal: null } }],
    ["print timeout", { stdout: PRINT_TIMEOUT, outcome: { exitCode: 1, signal: null } }],
    ["terminated", { stdout: "", outcome: { exitCode: null, signal: "SIGKILL" } }]
  ];

  it.each(failing)("leaves a non-empty errorMessage and a terminalSummary on the %s branch", (_name, overrides) => {
    const finalized = finalize(overrides);

    expect(finalized.status).toBe("failed");
    expect(finalized.errorClass).toBeTruthy();
    expect((finalized.errorMessage ?? "").trim().length).toBeGreaterThan(0);
    // Logs do not survive indefinitely; every question worth asking about a finished
    // job has to remain answerable from the record alone once its log is gone.
    expect(finalized.terminalSummary).toBeTruthy();
    expect(finalized.terminalSummary?.state).toBeTruthy();
    expect(finalized.terminalSummary?.resultComplete).toBe(false);
    expect(finalized.finishedAt).toBeTruthy();
  });
});

describe("the outcome of the process is recorded verbatim", () => {
  it("keeps exitCode, signal, outputTruncated and an explicit finishedAt", () => {
    const finishedAt = "2026-01-02T03:04:05.000Z";
    const finalized = finalize({
      outcome: { exitCode: 0, signal: null },
      outputTruncated: true,
      finishedAt
    });

    expect(finalized.exitCode).toBe(0);
    expect(finalized.signal).toBeNull();
    expect(finalized.outputTruncated).toBe(true);
    expect(finalized.finishedAt).toBe(finishedAt);
  });

  it("does not mutate the record it was handed", () => {
    const record = makeRecord();
    finalizeJobRecord({
      record,
      stdout: SUCCESS,
      stderr: "",
      outcome: { exitCode: 0, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("running");
    expect(record.finishedAt).toBeUndefined();
    expect(record.terminalSummary).toBeUndefined();
  });
});

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore, type JobRecord } from "../plugins/agy-plugin-codex/src/job-store.js";
import {
  agyResult,
  agyRun,
  agyStatus,
  configureWorkspaceRootsProvider
} from "../plugins/agy-plugin-codex/src/tools.js";
import { RECORDING_FAKE, withFakeAgy } from "./helpers/envelope.js";

/**
 * The wire shape itself, asserted directly rather than through readEnvelope.
 *
 * Every tool answers with `{ ok, error?, warnings, <cheap scalar mirrors>, data }`.
 * The rule that matters most is the one about duplication: the bulk fields cost
 * real tokens, so they live in `data` and nowhere else, while only cheap scalars are
 * mirrored at the top level for callers that read them positionally.
 */

type Envelope = {
  ok: boolean;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
  data?: Record<string, unknown>;
} & Record<string, unknown>;

const DEFAULT_ROOTS_PROVIDER = async () => [process.cwd()];
const MANAGED_ENV_KEYS = ["AGY_PLUGIN_STATE_DIR", "FAKE_INVOCATIONS", "FAKE_RESPONSE"];

/** Bulk fields: expensive to send, so they are never mirrored. */
const BULK_FIELDS = ["job", "record", "stdout", "stderr", "outputSummary"];

/** Cheap scalars a caller reads positionally, mirrored on purpose. */
const MIRRORED_SCALARS = ["background", "terminal", "nextAction", "resumable", "workspaceMode"];

const savedEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv.clear();
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  configureWorkspaceRootsProvider(DEFAULT_ROOTS_PROVIDER);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return await realpath(dir);
}

async function useWorkspace(): Promise<string> {
  const root = await makeTempDir("agy-envelope-workspace-");
  configureWorkspaceRootsProvider(async () => [root]);
  return root;
}

async function useStateDir(): Promise<string> {
  const stateDir = await makeTempDir("agy-envelope-state-");
  process.env.AGY_PLUGIN_STATE_DIR = stateDir;
  return stateDir;
}

/** A finished job record, so the observation tools answer without spawning anything. */
async function writeTerminalJob(id: string): Promise<JobRecord> {
  const store = new JobStore();
  const now = new Date().toISOString();
  const record: JobRecord = {
    id,
    kind: "run",
    status: "succeeded",
    cwd: store.stateDir,
    command: "/usr/bin/true",
    args: [],
    workspaceMode: "direct",
    agyConversationId: "11111111-2222-4333-8444-555555555555",
    resumable: true,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    timeoutMs: 600_000,
    exitCode: 0,
    stdoutPath: "",
    stderrPath: ""
  };
  await store.write(record);
  return record;
}

async function foregroundRunEnvelope(): Promise<Envelope> {
  const workspace = await useWorkspace();
  const result = await withFakeAgy(RECORDING_FAKE, () =>
    agyRun({ prompt: "hello", cwd: workspace, background: false, timeoutMs: 60_000 })
  );
  return result.structuredContent as Envelope;
}

describe("the wire shape is { ok, error?, warnings, <mirrors>, data }", () => {
  it("carries warnings as an array even when nothing went wrong", async () => {
    const envelope = await foregroundRunEnvelope();

    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.warnings)).toBe(true);
    // `warnings` is where this plugin puts everything it noticed but did not refuse
    // over, so a caller can always iterate it without a null check.
    expect(envelope).not.toHaveProperty("error");
  });

  it("puts the payload in data", async () => {
    const envelope = await foregroundRunEnvelope();

    expect(envelope.data).toBeTypeOf("object");
    expect(envelope.data).toHaveProperty("outputSummary");
    expect(envelope.data).toHaveProperty("exitCode");
  });

  it("answers a refusal with ok:false, a typed error and no data", async () => {
    configureWorkspaceRootsProvider(async () => []);

    const envelope = (await agyRun({ prompt: "hello", background: false }))
      .structuredContent as Envelope;

    expect(envelope.ok).toBe(false);
    // A boundary refusal is a returned envelope with a stable code, not an
    // exception: an MCP exception carries no code and no `retryable`.
    expect(envelope.error?.code).toBe("workspace_unavailable");
    expect(typeof envelope.error?.message).toBe("string");
    expect(typeof envelope.error?.retryable).toBe("boolean");
    expect(Array.isArray(envelope.warnings)).toBe(true);
    expect(envelope).not.toHaveProperty("data");
  });
});

describe("bulk fields are never duplicated between a top-level mirror and data", () => {
  it("keeps stdout, stderr and outputSummary inside data on a foreground run", async () => {
    const envelope = await foregroundRunEnvelope();

    expect(envelope.data).toHaveProperty("stdout");
    expect(envelope.data).toHaveProperty("stderr");
    expect(envelope.data).toHaveProperty("outputSummary");
    for (const field of BULK_FIELDS) {
      expect(envelope).not.toHaveProperty(field);
    }
  });

  it("keeps job inside data on agy_status", async () => {
    await useStateDir();
    const job = await writeTerminalJob("job_envelope_status");

    const envelope = (await agyStatus({ jobId: job.id })).structuredContent as Envelope;

    expect(envelope.data).toHaveProperty("job");
    for (const field of BULK_FIELDS) {
      expect(envelope).not.toHaveProperty(field);
    }
  });

  it("keeps record, stdout, stderr and outputSummary inside data on agy_result", async () => {
    await useStateDir();
    const job = await writeTerminalJob("job_envelope_result");

    const envelope = (await agyResult({ jobId: job.id })).structuredContent as Envelope;

    expect(envelope.data).toHaveProperty("record");
    expect(envelope.data).toHaveProperty("outputSummary");
    for (const field of BULK_FIELDS) {
      expect(envelope).not.toHaveProperty(field);
    }
  });
});

describe("the scalars that ARE mirrored agree with data", () => {
  it("mirrors background and workspaceMode on a run", async () => {
    const envelope = await foregroundRunEnvelope();

    for (const field of ["background", "workspaceMode"]) {
      expect(envelope).toHaveProperty(field);
      expect(envelope[field]).toEqual(envelope.data?.[field]);
    }
    expect(envelope.background).toBe(false);
    expect(envelope.workspaceMode).toBe("direct");
  });

  it("mirrors terminal, nextAction and resumable on agy_status", async () => {
    await useStateDir();
    const job = await writeTerminalJob("job_envelope_mirrors");

    const envelope = (await agyStatus({ jobId: job.id })).structuredContent as Envelope;

    for (const field of ["terminal", "nextAction", "resumable"]) {
      expect(envelope).toHaveProperty(field);
      expect(envelope[field]).toEqual(envelope.data?.[field]);
    }
    expect(envelope.terminal).toBe(true);
    expect(envelope.nextAction).toMatch(/do not poll again/i);
  });

  it("mirrors every scalar in the published set somewhere across the two envelopes", async () => {
    await useStateDir();
    const job = await writeTerminalJob("job_envelope_union");
    const runEnvelope = await foregroundRunEnvelope();
    const statusEnvelope = (await agyStatus({ jobId: job.id })).structuredContent as Envelope;

    // Stated as one assertion so a scalar dropped from the mirror set is caught
    // here rather than in whichever caller was reading it positionally.
    for (const field of MIRRORED_SCALARS) {
      const present = field in runEnvelope || field in statusEnvelope;
      expect(present, `${field} must be mirrored at the top level`).toBe(true);
    }
  });
});

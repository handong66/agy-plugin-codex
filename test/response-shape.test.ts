import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore, type JobRecord } from "../plugins/agy-plugin-codex/src/job-store.js";
import {
  agyRun,
  agyStatus,
  configureWorkspaceRootsProvider
} from "../plugins/agy-plugin-codex/src/tools.js";
import { RECORDING_FAKE, withFakeAgy } from "./helpers/envelope.js";

/**
 * How one answer is put on the wire.
 *
 * Every response used to go out twice: pretty-printed as `content[0].text` and again
 * as `structuredContent`. Small payloads still carry both, because callers read the
 * text; large ones are sent once and say so.
 */

/** The threshold in tools.ts, above which the text block becomes a notice. */
const MAX_TEXT_PAYLOAD_CHARS = 8_192;

const DEFAULT_ROOTS_PROVIDER = async () => [process.cwd()];
const MANAGED_ENV_KEYS = ["AGY_PLUGIN_STATE_DIR", "FAKE_INVOCATIONS", "FAKE_RESPONSE"];

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
  const root = await makeTempDir("agy-response-workspace-");
  configureWorkspaceRootsProvider(async () => [root]);
  return root;
}

async function writeTerminalJob(id: string): Promise<JobRecord> {
  const stateDir = await makeTempDir("agy-response-state-");
  process.env.AGY_PLUGIN_STATE_DIR = stateDir;
  const store = new JobStore();
  const now = new Date().toISOString();
  const record: JobRecord = {
    id,
    kind: "run",
    status: "succeeded",
    cwd: stateDir,
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

/** A run whose answer is `size` characters long, so the payload crosses the threshold. */
async function runWithResponseOfSize(size: number) {
  const workspace = await useWorkspace();
  process.env.FAKE_RESPONSE = "x".repeat(size);
  return await withFakeAgy(RECORDING_FAKE, () =>
    agyRun({ prompt: "hello", cwd: workspace, background: false, timeoutMs: 60_000 })
  );
}

describe("content[0].text is never pretty-printed", () => {
  it("serializes a small payload with no indentation", async () => {
    const job = await writeTerminalJob("job_response_small");

    const result = await agyStatus({ jobId: job.id });

    // Indentation is pure token cost on a channel nothing reads as prose.
    expect(result.content[0].text).not.toContain("\n  ");
    expect(result.content[0].text.startsWith("{\n")).toBe(false);
  });

  it("serializes the large-payload notice with no indentation either", async () => {
    const result = await runWithResponseOfSize(30_000);

    expect(result.content[0].text).not.toContain("\n  ");
  });
});

describe("a payload over 8192 characters is returned once", () => {
  it("replaces the text block with a short notice and keeps the whole payload in structuredContent", async () => {
    const result = await runWithResponseOfSize(30_000);

    const notice = JSON.parse(result.content[0].text) as {
      ok: boolean;
      structuredContentOnly: boolean;
      payloadChars: number;
      note: string;
    };
    expect(notice.structuredContentOnly).toBe(true);
    expect(notice.ok).toBe(true);
    expect(notice.payloadChars).toBeGreaterThan(MAX_TEXT_PAYLOAD_CHARS);
    expect(notice.note).toMatch(/structuredContent/);
    // The notice must be small; duplicating the payload is exactly what it avoids.
    expect(result.content[0].text.length).toBeLessThan(MAX_TEXT_PAYLOAD_CHARS);

    const structured = result.structuredContent as {
      data: { outputSummary: { finalText: string } };
    };
    expect(structured.data.outputSummary.finalText).toHaveLength(30_000);
    expect(JSON.stringify(result.structuredContent).length).toBe(notice.payloadChars);
  });
});

describe("a small payload carries both representations", () => {
  it("sends text and structuredContent that agree", async () => {
    const job = await writeTerminalJob("job_response_agree");

    const result = await agyStatus({ jobId: job.id });

    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_TEXT_PAYLOAD_CHARS);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    // A caller reading the text block must not have to know it was truncated.
    expect(result.content[0].text).not.toContain("structuredContentOnly");
  });
});

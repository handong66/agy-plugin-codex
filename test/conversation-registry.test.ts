import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConversations } from "../plugins/agy-plugin-codex/src/conversation-registry.js";
import type { JobRecord } from "../plugins/agy-plugin-codex/src/job-store.js";

/**
 * agy publishes no conversation list of its own -- no `conversations` subcommand,
 * and its on-disk conversation store is opaque protobuf in SQLite WAL files. So the
 * registry is this plugin's own job records, and the honest scope is "the
 * conversations THIS PLUGIN started".
 */

const tempDirs: string[] = [];
let stateDir: string;
let jobsDir: string;

beforeEach(async () => {
  // Kept under the repository (not the OS temp directory) so a state directory this
  // suite creates is always visible to `git status`; afterEach drains them, and the
  // `.agy-plugin-codex-test-` prefix is the one .gitignore is meant to cover.
  stateDir = await mkdtemp(join(process.cwd(), ".agy-plugin-codex-test-"));
  tempDirs.push(stateDir);
  jobsDir = join(stateDir, "jobs");
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Job ids embed their creation time: `job_<epochMs>_<random>`. */
function jobId(epochMs: number, suffix = "aaaa1111"): string {
  return `job_${epochMs}_${suffix}`;
}

async function writeRecord(overrides: Partial<JobRecord> & { id: string }): Promise<JobRecord> {
  const record: JobRecord = {
    kind: "run",
    status: "succeeded",
    cwd: "/Users/someone/projects/thing",
    command: "/opt/homebrew/bin/agy",
    args: ["--add-dir", "/Users/someone/projects/thing", "-p", "hello"],
    workspaceMode: "direct",
    createdAt: new Date().toISOString(),
    timeoutMs: 600_000,
    stdoutPath: join(jobsDir, `${overrides.id}.stdout.log`),
    stderrPath: join(jobsDir, `${overrides.id}.stderr.log`),
    ...overrides
  };
  await writeFile(join(jobsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600
  });
  return record;
}

describe("listConversations answers newest first", () => {
  it("orders by the epoch millis embedded in the job id", async () => {
    await writeRecord({ id: jobId(1_700_000_001_000), agyConversationId: "conv-oldest" });
    await writeRecord({ id: jobId(1_700_000_002_000), agyConversationId: "conv-middle" });
    await writeRecord({ id: jobId(1_700_000_003_000), agyConversationId: "conv-newest" });

    const { conversations, scanned, skipped } = await listConversations({ stateDir });

    // Every id this plugin mints has a 13-digit epoch, so the lexical sort the
    // registry uses is a chronological one -- asserted with ids a second apart.
    expect(conversations.map((item) => item.conversationId)).toEqual([
      "conv-newest",
      "conv-middle",
      "conv-oldest"
    ]);
    expect(scanned).toBe(3);
    expect(skipped).toBe(0);
  });

  it("collapses several jobs on one conversation to the most recent job", async () => {
    await writeRecord({
      id: jobId(1_700_000_001_000, "first000"),
      agyConversationId: "conv-shared",
      kind: "run",
      status: "succeeded"
    });
    await writeRecord({
      id: jobId(1_700_000_002_000, "second00"),
      agyConversationId: "conv-shared",
      kind: "continue",
      status: "failed"
    });

    const { conversations } = await listConversations({ stateDir });

    expect(conversations).toHaveLength(1);
    // A run and then its continuations share one conversation; only the latest job's
    // log still describes the conversation's current state.
    expect(conversations[0]?.jobId).toBe(jobId(1_700_000_002_000, "second00"));
    expect(conversations[0]?.kind).toBe("continue");
    expect(conversations[0]?.status).toBe("failed");
  });
});

describe("a record with nothing to resume is not a conversation", () => {
  it("omits records that never observed an agyConversationId", async () => {
    await writeRecord({ id: jobId(1_700_000_001_000), agyConversationId: "conv-real" });
    // A job that failed before agy allocated a conversation has no resume handle,
    // so listing it would offer the caller something agy_continue cannot use.
    await writeRecord({ id: jobId(1_700_000_002_000, "nohandle"), status: "failed" });

    const { conversations, scanned } = await listConversations({ stateDir });

    expect(conversations.map((item) => item.conversationId)).toEqual(["conv-real"]);
    // The record was still read; it just did not become a conversation, and that is
    // not the same thing as being skipped.
    expect(scanned).toBe(2);
  });
});

describe("a corrupt record is counted, not thrown", () => {
  it("reports unreadable JSON in `skipped` and still lists the rest", async () => {
    await writeRecord({ id: jobId(1_700_000_001_000), agyConversationId: "conv-good" });
    await writeFile(join(jobsDir, `${jobId(1_700_000_002_000, "corrupt0")}.json`), "{ not json");
    // A record half-written by a worker that died mid-rename is exactly this shape,
    // and it must not take down the recovery path the caller reached for.
    await writeFile(join(jobsDir, `${jobId(1_700_000_003_000, "empty000")}.json`), "");

    const { conversations, scanned, skipped } = await listConversations({ stateDir });

    expect(conversations.map((item) => item.conversationId)).toEqual(["conv-good"]);
    expect(scanned).toBe(3);
    expect(skipped).toBe(2);
  });
});

describe("roots scope the listing to the workspace the caller is in", () => {
  const inside = "/Users/someone/projects/thing";
  const outside = "/Users/someone/projects/other";

  beforeEach(async () => {
    await writeRecord({ id: jobId(1_700_000_001_000, "inside00"), agyConversationId: "conv-inside", cwd: inside });
    await writeRecord({
      id: jobId(1_700_000_002_000, "nested00"),
      agyConversationId: "conv-nested",
      cwd: join(inside, "packages", "app")
    });
    await writeRecord({
      id: jobId(1_700_000_003_000, "outside0"),
      agyConversationId: "conv-outside",
      cwd: outside
    });
  });

  it("filters out a record whose cwd is outside the roots by default", async () => {
    const { conversations } = await listConversations({ stateDir, roots: [inside] });

    expect(conversations.map((item) => item.conversationId).sort()).toEqual(["conv-inside", "conv-nested"]);
  });

  it("includes it when the caller explicitly asks for every directory", async () => {
    const { conversations } = await listConversations({
      stateDir,
      roots: [inside],
      includeAllDirectories: true
    });

    expect(conversations).toHaveLength(3);
  });

  it("does not scope at all when no roots were supplied", async () => {
    expect((await listConversations({ stateDir })).conversations).toHaveLength(3);
    expect((await listConversations({ stateDir, roots: [] })).conversations).toHaveLength(3);
  });

  it("does not treat a sibling directory with a shared prefix as inside a root", async () => {
    await writeRecord({
      id: jobId(1_700_000_004_000, "sibling0"),
      agyConversationId: "conv-sibling",
      cwd: `${inside}-backup`
    });

    const { conversations } = await listConversations({ stateDir, roots: [inside] });

    expect(conversations.map((item) => item.conversationId)).not.toContain("conv-sibling");
  });
});

describe("limit is honoured and clamped", () => {
  beforeEach(async () => {
    for (let index = 0; index < 105; index += 1) {
      await writeRecord({
        id: jobId(1_700_000_000_000 + index * 1_000, `pad${String(index).padStart(5, "0")}`),
        agyConversationId: `conv-${index}`
      });
    }
  });

  it("returns exactly what was asked for", async () => {
    expect((await listConversations({ stateDir, limit: 5 })).conversations).toHaveLength(5);
  });

  it("clamps a limit below 1 up to 1", async () => {
    expect((await listConversations({ stateDir, limit: 0 })).conversations).toHaveLength(1);
    expect((await listConversations({ stateDir, limit: -20 })).conversations).toHaveLength(1);
  });

  it("clamps a limit above 100 down to 100", async () => {
    expect((await listConversations({ stateDir, limit: 1_000 })).conversations).toHaveLength(100);
  });

  it("defaults to 20", async () => {
    expect((await listConversations({ stateDir })).conversations).toHaveLength(20);
  });
});

describe("a missing state directory is an empty listing, not a failure", () => {
  it("returns nothing rather than throwing", async () => {
    // agy_conversations is the recovery path a caller reaches for after losing a
    // job handle. Throwing here would take away the last thing that still works.
    const result = await listConversations({ stateDir: join(stateDir, "does-not-exist") });

    expect(result).toEqual({ conversations: [], scanned: 0, skipped: 0 });
  });
});

describe("the preview comes off the record, so it outlives the log", () => {
  it("is single-lined and bounded to 200 characters", async () => {
    const finalTextPreview = `line one\nline two\n\n   indented three\n${"x".repeat(500)}`;
    await writeRecord({
      id: jobId(1_700_000_001_000),
      agyConversationId: "conv-preview",
      observedModel: "gemini-3.7-flash-low",
      finishedAt: new Date().toISOString(),
      terminalSummary: {
        state: "succeeded_with_text",
        resultComplete: true,
        finalTextPreview,
        finalTextTruncated: true,
        permissionDenied: false,
        deniedTargets: [],
        toolCallCount: 3,
        filesInspected: 2,
        turnsUsed: 1,
        evidenceLevel: "thin",
        observedModel: "gemini-3.7-flash-low"
      }
    });

    const { conversations } = await listConversations({ stateDir });
    const preview = conversations[0]?.preview ?? "";

    expect(preview.startsWith("line one line two indented three")).toBe(true);
    // A listing is a menu, not a transcript: newlines would let one entry take over
    // the whole rendering.
    expect(preview).not.toContain("\n");
    expect(preview).toHaveLength(200);
    expect(conversations[0]?.resultComplete).toBe(true);
    expect(conversations[0]?.observedModel).toBe("gemini-3.7-flash-low");
  });

  it("omits preview and resultComplete for a record that never got a terminal summary", async () => {
    await writeRecord({
      id: jobId(1_700_000_001_000),
      agyConversationId: "conv-no-summary",
      status: "running"
    });

    const { conversations } = await listConversations({ stateDir });

    expect(conversations[0]?.preview).toBeUndefined();
    expect(conversations[0]?.resultComplete).toBeUndefined();
    expect(conversations[0]?.status).toBe("running");
  });
});

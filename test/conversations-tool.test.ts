import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agyConversations,
  configureWorkspaceRootsProvider
} from "../plugins/agy-plugin-codex/src/tools.js";
import type { JobRecord } from "../plugins/agy-plugin-codex/src/job-store.js";
import { readEnvelope } from "./helpers/envelope.js";

/**
 * `agy_conversations` is the recovery tool, and recovery has to work in the state
 * the caller is actually in. It reads only this plugin's own job records and never
 * runs agy, so it is the one execution-adjacent tool that degrades instead of
 * refusing when no workspace root is available.
 */

const tempDirs: string[] = [];
const restoreEnv: Array<[string, string | undefined]> = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setEnv(name: string, value: string | undefined): void {
  restoreEnv.push([name, process.env[name]]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  configureWorkspaceRootsProvider(async () => [process.cwd()]);
  while (restoreEnv.length) {
    const [name, value] = restoreEnv.pop()!;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedRecord(stateDir: string, record: Partial<JobRecord> & { id: string }): Promise<void> {
  const jobsDir = join(stateDir, "jobs");
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  const full = {
    kind: "run",
    status: "succeeded",
    cwd: "/tmp/unset",
    command: "/opt/homebrew/bin/agy",
    args: ["--add-dir", "/tmp/unset"],
    workspaceMode: "direct",
    createdAt: new Date().toISOString(),
    timeoutMs: 600_000,
    stdoutPath: "",
    stderrPath: "",
    ...record
  };
  const path = join(jobsDir, `${record.id}.json`);
  await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

describe("agy_conversations", () => {
  it("lists everything with a warning when no workspace root is available", async () => {
    const stateDir = await tempDir("agy-conv-state-");
    setEnv("AGY_PLUGIN_STATE_DIR", stateDir);
    await seedRecord(stateDir, {
      id: "job_1000000000000_aaaaaaaa",
      cwd: "/somewhere/else",
      agyConversationId: "11111111-2222-4333-8444-555555555555"
    });
    // The session that lost a job handle is often exactly the session with no roots,
    // so refusing here would break the one call made to recover from that.
    configureWorkspaceRootsProvider(async () => ({
      roots: [],
      diagnostics: { supported: true, ok: false, count: 0, errorCode: "method_not_found" }
    }));

    const envelope = readEnvelope<{
      ok: boolean;
      warnings: string[];
      conversations: Array<{ conversationId: string }>;
    }>(await agyConversations({}));

    expect(envelope.ok).toBe(true);
    expect(envelope.conversations.map((c) => c.conversationId)).toEqual([
      "11111111-2222-4333-8444-555555555555"
    ]);
    expect(envelope.warnings.join(" ")).toContain("not scoped to a project");
  });

  it("scopes to the workspace roots when they are available", async () => {
    const stateDir = await tempDir("agy-conv-state-");
    const workspace = await tempDir("agy-conv-workspace-");
    // The realpath, because that is what a real record holds: every job's cwd goes
    // through `cwdWithinWorkspace`, which resolves it before the record is written.
    // On macOS the temp path and its realpath differ by the /private prefix.
    const resolvedWorkspace = await realpath(workspace);
    setEnv("AGY_PLUGIN_STATE_DIR", stateDir);
    await seedRecord(stateDir, {
      id: "job_1000000000000_aaaaaaaa",
      cwd: resolvedWorkspace,
      agyConversationId: "aaaaaaaa-0000-4000-8000-000000000001"
    });
    await seedRecord(stateDir, {
      id: "job_1000000000001_bbbbbbbb",
      cwd: "/somewhere/else",
      agyConversationId: "bbbbbbbb-0000-4000-8000-000000000002"
    });
    configureWorkspaceRootsProvider(async () => [workspace]);

    const scoped = readEnvelope<{ conversations: Array<{ conversationId: string }> }>(
      await agyConversations({})
    );
    expect(scoped.conversations.map((c) => c.conversationId)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001"
    ]);

    const all = readEnvelope<{ conversations: Array<{ conversationId: string }> }>(
      await agyConversations({ includeAllDirectories: true })
    );
    expect(all.conversations.map((c) => c.conversationId).sort()).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
      "bbbbbbbb-0000-4000-8000-000000000002"
    ]);
  });

  it("always says the listing is the plugin's own, not agy's", async () => {
    const stateDir = await tempDir("agy-conv-state-");
    setEnv("AGY_PLUGIN_STATE_DIR", stateDir);
    configureWorkspaceRootsProvider(async () => [await tempDir("agy-conv-workspace-")]);

    const envelope = readEnvelope<{ ok: boolean; warnings: string[] }>(await agyConversations({}));

    expect(envelope.ok).toBe(true);
    // agy publishes no conversation listing at all -- no subcommand, protobuf state,
    // and a summaries index the desktop app owns -- so a caller must not read this as
    // "these are all my agy conversations".
    expect(envelope.warnings.join(" ")).toContain("THIS PLUGIN started");
  });
});

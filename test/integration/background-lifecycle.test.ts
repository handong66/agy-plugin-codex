import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * A background job outlives the MCP server process that started it.
 *
 * That is the whole point of the worker being spawned detached with its own process
 * group: the client that submitted a job is often gone by the time the job matters,
 * and the job record on disk -- not the connection -- is what carries it. This file
 * proves the claim end to end, with two separate server processes.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverPath = join(repoRoot, "plugins", "agy-plugin-codex", "dist", "server.js");

/**
 * A fake agy that will not go quietly.
 *
 * It streams a couple of NDJSON lines so the run looks alive, TRAPS SIGTERM so a
 * polite signal cannot end it, and only writes its marker file after a long delay.
 * If the marker ever appears, something signalled the worker without reaching the
 * process group the worker put agy in.
 */
const SLOW_FAKE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("1.1.16"); process.exit(0); }
if (process.env.SLOW_FAKE_PID_FILE) writeFileSync(process.env.SLOW_FAKE_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
const cid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
process.stdout.write(JSON.stringify({ event: "init", conversation_id: cid, init: { model: "gemini-3.7-flash-low", cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } }) + "\\n");
process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: cid, step_index: 0, state: "DONE", step_type: "user_input" } }) + "\\n");
setTimeout(() => {
  writeFileSync(process.env.SLOW_FAKE_MARKER, "the slow fake ran to completion");
  process.exit(0);
}, 15000);
`;

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type Envelope = {
  ok: boolean;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
  data: Record<string, unknown>;
} & Record<string, unknown>;

async function startClient(options: {
  workspace: string;
  scratch: string;
  env: Record<string, string>;
}): Promise<Client> {
  const client = new Client(
    { name: "agy-lifecycle-test", version: "0.0.0" },
    { capabilities: { roots: {} } }
  );
  clients.push(client);
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(options.workspace).href, name: "workspace" }]
  }));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: options.scratch,
      env: options.env,
      stderr: "pipe"
    })
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    structuredContent: Envelope;
  };
  return result.structuredContent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor<T>(
  label: string,
  attempt: () => Promise<T | undefined>,
  budgetMs = 15_000
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = await attempt();
    if (value !== undefined) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("a background job survives the process that started it", () => {
  it(
    "is started by one client, observed and cancelled by another, and takes its whole process group down with it",
    async () => {
      const workspace = await makeTempDir("agy-lifecycle-workspace-");
      const scratch = await makeTempDir("agy-lifecycle-scratch-");
      const stateDir = await makeTempDir("agy-lifecycle-state-");
      const binDir = await makeTempDir("agy-lifecycle-bin-");
      const agyBin = join(binDir, "slow-agy.mjs");
      const marker = join(binDir, "marker.txt");
      const pidFile = join(binDir, "agy.pid");
      await writeFile(agyBin, SLOW_FAKE);
      await chmod(agyBin, 0o755);

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        AGY_BIN: agyBin,
        AGY_PLUGIN_STATE_DIR: stateDir,
        SLOW_FAKE_MARKER: marker,
        SLOW_FAKE_PID_FILE: pidFile
      };
      delete env.AGY_WORKSPACE_ROOTS;
      delete env.CODEX_THREAD_ID;

      const clientA = await startClient({ workspace, scratch, env });
      const submitted = await call(clientA, "agy_run", {
        prompt: "take your time",
        cwd: workspace,
        background: true,
        timeoutMs: 600_000
      });

      expect(submitted.ok).toBe(true);
      expect(submitted.background).toBe(true);
      const jobId = (submitted.data.job as { id: string }).id;
      expect(jobId).toMatch(/^job_/);

      // The submitting client goes away. The worker was spawned detached and
      // unref'd, so the job is now owned by the record on disk, not by this
      // connection.
      await clientA.close();
      clients.splice(clients.indexOf(clientA), 1);

      const clientB = await startClient({ workspace, scratch, env });
      const running = await waitFor("the job to report running", async () => {
        const status = await call(clientB, "agy_status", { jobId });
        return (status.data.job as { status: string }).status === "running" ? status : undefined;
      });
      expect(running.ok).toBe(true);
      expect(running.terminal).toBe(false);

      // The worker marks the job running BEFORE it spawns agy, so the fake's pid
      // file appears a moment later. Polling for it keeps the test about the
      // process group rather than about that ordering.
      const agyPid = await waitFor("the fake agy to record its pid", async () => {
        const raw = await readFile(pidFile, "utf8").catch(() => "");
        const pid = Number(raw.trim());
        return raw.trim() && Number.isSafeInteger(pid) ? pid : undefined;
      });
      expect(isAlive(agyPid)).toBe(true);

      const cancelled = await call(clientB, "agy_cancel", { jobId });
      expect(cancelled.ok).toBe(false);
      expect(cancelled.error?.code).toBe("cancelled");
      expect(cancelled.terminal).toBe(true);

      const afterCancel = await call(clientB, "agy_status", { jobId });
      expect(afterCancel.ok).toBe(false);
      expect(afterCancel.terminal).toBe(true);
      expect((afterCancel.data.job as { status: string }).status).toBe("cancelled");

      // The fake ignores SIGTERM, so only a signal that reached the whole group and
      // escalated to SIGKILL can have ended it. A cancel that signalled just the
      // worker would leave this process running.
      await waitFor("the agy process group to die", async () => (isAlive(agyPid) ? undefined : true));
      expect(existsSync(marker)).toBe(false);

      // A blocking wait on a record that is already final must not spend the budget:
      // the record cannot change, and the response says so.
      const waited = await call(clientB, "agy_status", { jobId, waitMs: 5_000 });
      expect(waited.data.waited as number).toBeLessThan(1_000);
      expect(String(waited.nextAction)).toMatch(/do not poll again/i);
    },
    30_000
  );
});

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The PUBLISHED contract, read off the built server over real stdio.
 *
 * A caller only ever sees what `tools/list` advertises, so these assertions are
 * deliberately made against the wire rather than against the zod fragments in
 * server.ts: a refactor that stops sharing a fragment must fail here.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverPath = join(repoRoot, "plugins", "agy-plugin-codex", "dist", "server.js");

const ALL_TOOLS = [
  "agy_check",
  "agy_run",
  "agy_continue",
  "agy_rescue",
  "agy_review",
  "agy_adversarial_review",
  "agy_conversations",
  "agy_status",
  "agy_result",
  "agy_cancel"
];

/** Every tool that starts an agy run, and therefore publishes a budget. */
const EXECUTION_TOOLS = ["agy_run", "agy_continue", "agy_rescue", "agy_review", "agy_adversarial_review"];

/** Tools that resolve central job state by id alone. */
const JOB_ID_ONLY_TOOLS = ["agy_status", "agy_result", "agy_cancel"];

const tempDirs: string[] = [];
const clients: Client[] = [];
let tools: Tool[] = [];
let byName = new Map<string, Tool>();
let client: Client;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function schemaProperties(tool: Tool | undefined): Record<string, Record<string, unknown>> {
  return (tool?.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
}

beforeAll(async () => {
  expect(existsSync(serverPath), `built server not found at ${serverPath}; run npm run build`).toBe(
    true
  );
  // The server's own working directory is a scratch dir on purpose: nothing in the
  // discovery chain may quietly promote it to a workspace root.
  const scratch = await makeTempDir("agy-contract-scratch-");
  const stateDir = await makeTempDir("agy-contract-state-");

  client = new Client({ name: "agy-contract-test", version: "0.0.0" }, { capabilities: { roots: {} } });
  clients.push(client);
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(repoRoot).href, name: "agy-plugin-codex" }]
  }));

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: scratch,
      env: { ...process.env, AGY_PLUGIN_STATE_DIR: stateDir } as Record<string, string>,
      stderr: "pipe"
    })
  );

  tools = (await client.listTools()).tools;
  byName = new Map(tools.map((tool) => [tool.name, tool]));
});

afterAll(async () => {
  for (const openClient of clients.splice(0)) {
    await openClient.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("the server identifies itself with the released version", () => {
  it("advertises the same version package.json publishes", async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };

    // This string is the version a caller sees on the wire, so a drift here is a
    // drift in what the user is told they are running.
    expect(client.getServerVersion()?.version).toBe(packageJson.version);
  });
});

describe("the published tool set", () => {
  it("contains exactly the ten tools and no extras", () => {
    expect([...byName.keys()].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it("never exposes agyBin, because a caller-supplied executable path is arbitrary execution", () => {
    for (const tool of tools) {
      expect(schemaProperties(tool), tool.name).not.toHaveProperty("agyBin");
    }
  });
});

describe("every execution tool publishes one budget contract", () => {
  it("uses an identical floor, ceiling and description for timeoutMs", () => {
    const timeouts = EXECUTION_TOOLS.map((name) => schemaProperties(byName.get(name)).timeoutMs);

    for (const [index, timeout] of timeouts.entries()) {
      expect(timeout, EXECUTION_TOOLS[index]).toBeTruthy();
      expect(timeout.minimum, EXECUTION_TOOLS[index]).toBe(10_000);
      expect(timeout.maximum, EXECUTION_TOOLS[index]).toBe(86_400_000);
    }
    // One shared fragment, one published wording: a tool that drifts here teaches a
    // caller a second dialect of the same field.
    const descriptions = new Set(timeouts.map((timeout) => String(timeout.description)));
    expect(descriptions.size).toBe(1);
  });

  it("refuses a timeoutMs below the floor as an MCP error naming the floor", async () => {
    const result = (await client.callTool({
      name: "agy_run",
      arguments: { prompt: "hello", timeoutMs: 1_000 }
    })) as unknown as { isError?: boolean; content: { type: string; text: string }[] };

    // The SDK reports a schema violation as an isError result carrying the JSON-RPC
    // error text rather than as a rejected promise. Either way it must name the
    // floor, so a caller can fix the call instead of guessing at the range.
    expect(result.isError).toBe(true);
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("agy_run");
    expect(text).toContain("10000");
  });
});

describe("the observation tools take a job id, not a workspace", () => {
  it("does not accept cwd on agy_status, agy_result or agy_cancel", () => {
    for (const name of JOB_ID_ONLY_TOOLS) {
      expect(schemaProperties(byName.get(name)), name).not.toHaveProperty("cwd");
    }
  });

  it("accepts waitMs on agy_status and agy_result, so one blocking wait replaces a poll loop", () => {
    for (const name of ["agy_status", "agy_result"]) {
      expect(schemaProperties(byName.get(name)), name).toHaveProperty("waitMs");
    }
  });

  it("annotates only the observing tools as read-only", () => {
    for (const name of ["agy_check", "agy_conversations", "agy_status", "agy_result"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    // A write-capable or state-changing tool that claimed readOnlyHint would have a
    // client in goal mode skip the approval it should be asking for.
    for (const name of ["agy_run", "agy_continue", "agy_rescue", "agy_cancel"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).not.toBe(true);
    }
  });
});

describe("a tool that claims a read-only guarantee cannot widen its own reach", () => {
  it("names exactly the two review tools, and neither accepts allowCodexPrivatePaths", () => {
    const claimsReadOnly = tools
      .filter((tool) => /read-only guarantee/i.test(tool.description ?? ""))
      .map((tool) => tool.name);

    expect(claimsReadOnly.sort()).toEqual(["agy_adversarial_review", "agy_review"]);
    for (const name of claimsReadOnly) {
      expect(schemaProperties(byName.get(name)), name).not.toHaveProperty("allowCodexPrivatePaths");
    }
  });
});

describe("the tool descriptions carry the load-bearing agy facts", () => {
  it("says that agy_run, agy_continue and agy_rescue are write-capable", () => {
    // agy has no read-only permission mode, so a caller that assumes otherwise
    // loses files (AGY-RUNTIME-CONTRACT.md §3).
    for (const name of ["agy_run", "agy_continue", "agy_rescue"]) {
      expect(byName.get(name)?.description ?? "", name).toMatch(/write-capable/i);
    }
  });

  it("says both review tools run against a disposable copy", () => {
    for (const name of ["agy_review", "agy_adversarial_review"]) {
      expect(byName.get(name)?.description ?? "", name).toMatch(/disposable copy/i);
    }
  });

  it("warns on agy_continue's conversationId that an unknown id starts a fresh conversation", () => {
    const conversationId = schemaProperties(byName.get("agy_continue")).conversationId;

    // Measured: agy warns on stderr, exits 0 and starts a FRESH conversation rather
    // than failing, so a caller resuming a lost handle gets a confident answer from
    // a model with none of the context it thinks it has.
    expect(String(conversationId.description)).toMatch(/fresh conversation/i);
  });
});

describe("agy_result's maxChars clamps rather than refusing", () => {
  it("documents the clamp in the published description", () => {
    const maxChars = schemaProperties(byName.get("agy_result")).maxChars;

    expect(String(maxChars.description)).toMatch(/clamped to 100000/);
    expect(maxChars.maximum).toBe(1_000_000);
  });

  it("accepts a maxChars of 1000000 at the schema and answers with the tool's own refusal", async () => {
    const result = (await client.callTool({
      name: "agy_result",
      arguments: { jobId: "job_no_such_job", maxChars: 1_000_000 }
    })) as unknown as { structuredContent: { ok: boolean; error?: { code: string } } };

    // A caller widening its window should get the tail it asked for, not a protocol
    // error: the only refusal here is the missing job.
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.error?.code).toBe("job_not_found");
  });
});

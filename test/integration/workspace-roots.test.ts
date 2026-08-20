import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * The workspace-root discovery chain, exercised against the installed server.
 *
 * agy has no process-cwd fallback: without `--add-dir` it operates inside
 * ~/.gemini/antigravity-cli and sees none of the repository, and it does not fail
 * when that happens (AGY-RUNTIME-CONTRACT.md §2, §9). So every link in the chain is
 * a correctness property, and "no root" has to be a refusal rather than a default.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverPath = join(repoRoot, "plugins", "agy-plugin-codex", "dist", "server.js");

/** A fake agy that answers one successful run, so a refusal is unambiguous. */
const SUCCESSFUL_FAKE = `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("1.1.16"); process.exit(0); }
if (process.argv[2] === "models") {
  process.stdout.write("Fetching available models...\\ngemini-3.7-flash-low\\tGemini 3.7 Flash (Low)\\n");
  process.exit(0);
}
const cid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const argv = process.argv.slice(2);
const addDir = argv[argv.indexOf("--add-dir") + 1];
process.stdout.write(JSON.stringify({ event: "init", conversation_id: cid, init: { model: "gemini-3.7-flash-low", cwd: addDir, tools: [], permission_mode: "always-proceed" } }) + "\\n");
process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: cid, status: "SUCCESS", response: "worked in " + addDir, duration_seconds: 0.1, num_turns: 1 } }) + "\\n");
process.exit(0);
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
  return await realpath(dir);
}

/**
 * The environment a plugin server is started with in these tests.
 *
 * CODEX_THREAD_ID, CODEX_HOME and AGY_WORKSPACE_ROOTS are DELETED before the
 * overrides are applied. Without that, the developer's own live Codex session
 * supplies a rollout cwd through the session-metadata link of the chain, and a test
 * asserting "no root is available" quietly passes for the wrong reason.
 */
function isolatedPluginEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_HOME;
  delete env.AGY_WORKSPACE_ROOTS;
  return { ...env, ...overrides };
}

type Envelope = {
  ok: boolean;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
  data: Record<string, unknown>;
} & Record<string, unknown>;

type WorkspaceSources = {
  rootsList: { supported: boolean; ok: boolean; count: number; errorCode?: string };
  requestMeta: { metaPresent: boolean; workspaceCount: number; parseSucceeded: boolean };
  configuredRoots?: { configured: boolean; ok: boolean; count: number; errorCode?: string };
  callerCwd?: { provided: boolean; ok: boolean; count: number; errorCode?: string };
};

type Fixture = { workspace: string; scratch: string; agyBin: string; stateDir: string };

async function fixture(): Promise<Fixture> {
  const workspace = await makeTempDir("agy-roots-workspace-");
  const scratch = await makeTempDir("agy-roots-scratch-");
  const stateDir = await makeTempDir("agy-roots-state-");
  const binDir = await makeTempDir("agy-roots-bin-");
  const agyBin = join(binDir, "fake-agy.mjs");
  await writeFile(agyBin, SUCCESSFUL_FAKE);
  await chmod(agyBin, 0o755);
  return { workspace, scratch, agyBin, stateDir };
}

async function startClient(options: {
  scratch: string;
  env: Record<string, string>;
  /** undefined means the client does not advertise the roots capability at all. */
  roots?: string[];
}): Promise<Client> {
  const supportsRoots = options.roots !== undefined;
  const client = new Client(
    { name: "agy-roots-test", version: "0.0.0" },
    { capabilities: supportsRoots ? { roots: {} } : {} }
  );
  clients.push(client);
  if (supportsRoots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: (options.roots ?? []).map((root) => ({ uri: pathToFileURL(root).href, name: "root" }))
    }));
  }
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

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>
): Promise<Envelope> {
  const result = (await client.callTool({
    name,
    arguments: args,
    ...(meta ? { _meta: meta as Record<string, unknown> } : {})
  } as Parameters<Client["callTool"]>[0])) as unknown as { structuredContent: Envelope };
  return result.structuredContent;
}

describe("the server's own working directory is never a workspace root", () => {
  it("refuses agy_run when there are no roots, no metadata and no configured roots", async () => {
    const { scratch, agyBin, stateDir } = await fixture();
    const client = await startClient({
      scratch,
      roots: [],
      env: isolatedPluginEnv({ AGY_BIN: agyBin, AGY_PLUGIN_STATE_DIR: stateDir })
    });

    const envelope = await call(client, "agy_run", { prompt: "hello", background: false });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("workspace_unavailable");
    // Running in the server's own directory would be worse than refusing: agy would
    // report SUCCESS having read none of the repository.
    expect(JSON.stringify(envelope)).not.toContain(scratch);
  });
});

describe("per-call Codex workspace metadata is honoured", () => {
  it("accepts x-codex-turn-metadata as an object", async () => {
    const { workspace, scratch, agyBin, stateDir } = await fixture();
    const client = await startClient({
      scratch,
      roots: [],
      env: isolatedPluginEnv({ AGY_BIN: agyBin, AGY_PLUGIN_STATE_DIR: stateDir })
    });

    const envelope = await call(
      client,
      "agy_run",
      { prompt: "hello", background: false, timeoutMs: 60_000 },
      { "x-codex-turn-metadata": { workspaces: { [workspace]: {} } } }
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.workspaceMode).toBe("direct");
  });

  it("accepts the same metadata serialized as a JSON string", async () => {
    const { workspace, scratch, agyBin, stateDir } = await fixture();
    const client = await startClient({
      scratch,
      roots: [],
      env: isolatedPluginEnv({ AGY_BIN: agyBin, AGY_PLUGIN_STATE_DIR: stateDir })
    });

    // Codex's own app-tools bridge accepts either form, and a plugin MCP call can
    // cross the same executor boundary: discarding the string would silently drop
    // the only workspace on offer.
    const envelope = await call(
      client,
      "agy_run",
      { prompt: "hello", background: false, timeoutMs: 60_000 },
      { "x-codex-turn-metadata": JSON.stringify({ workspaces: { [workspace]: {} } }) }
    );

    expect(envelope.ok).toBe(true);
  });
});

describe("an explicit cwd is a workspace source of its own", () => {
  it("accepts an absolute cwd when every other source is empty", async () => {
    const { workspace, scratch, agyBin, stateDir } = await fixture();
    const client = await startClient({
      scratch,
      roots: [],
      env: isolatedPluginEnv({ AGY_BIN: agyBin, AGY_PLUGIN_STATE_DIR: stateDir })
    });

    const envelope = await call(client, "agy_run", {
      prompt: "hello",
      cwd: workspace,
      background: false,
      timeoutMs: 60_000
    });

    expect(envelope.ok).toBe(true);
  });

  it("refuses a relative cwd without echoing the value back", async () => {
    const { scratch, agyBin, stateDir } = await fixture();
    const relativeCwd = "some/relative/path-a41f";
    const client = await startClient({
      scratch,
      roots: [],
      env: isolatedPluginEnv({ AGY_BIN: agyBin, AGY_PLUGIN_STATE_DIR: stateDir })
    });

    const run = await call(client, "agy_run", {
      prompt: "hello",
      cwd: relativeCwd,
      background: false
    });
    expect(run.ok).toBe(false);
    expect(JSON.stringify(run)).not.toContain(relativeCwd);

    const check = await call(client, "agy_check", { cwd: relativeCwd, includeModels: false });
    const sources = check.data.workspaceSources as WorkspaceSources;
    // The diagnostic says a cwd was supplied and was unusable, and says it without
    // repeating a caller-controlled string into the transcript.
    expect(sources.callerCwd).toEqual({ provided: true, ok: false, count: 0, errorCode: "invalid_caller_cwd" });
    expect(JSON.stringify(sources)).not.toContain(relativeCwd);
  });
});

describe("AGY_WORKSPACE_ROOTS is the configured fallback", () => {
  it("uses it when nothing else supplies a root", async () => {
    const { workspace, scratch, agyBin, stateDir } = await fixture();
    const client = await startClient({
      scratch,
      roots: [],
      env: isolatedPluginEnv({
        AGY_BIN: agyBin,
        AGY_PLUGIN_STATE_DIR: stateDir,
        AGY_WORKSPACE_ROOTS: workspace
      })
    });

    const envelope = await call(client, "agy_run", {
      prompt: "hello",
      background: false,
      timeoutMs: 60_000
    });

    expect(envelope.ok).toBe(true);
  });

  it("reports a malformed value as invalid_configured_roots without echoing it", async () => {
    const { scratch, agyBin, stateDir } = await fixture();
    const malformed = "relative/configured/root-9c2e";
    const client = await startClient({
      scratch,
      roots: [],
      env: isolatedPluginEnv({
        AGY_BIN: agyBin,
        AGY_PLUGIN_STATE_DIR: stateDir,
        AGY_WORKSPACE_ROOTS: malformed
      })
    });

    const check = await call(client, "agy_check", { includeModels: false });
    const sources = check.data.workspaceSources as WorkspaceSources;

    expect(sources.configuredRoots).toEqual({
      configured: true,
      ok: false,
      count: 0,
      errorCode: "invalid_configured_roots"
    });
    // A misconfigured environment variable is a fact about the environment, not a
    // string worth reprinting: the diagnostic names the source and the fault only.
    expect(JSON.stringify(check)).not.toContain(malformed);
  });
});

describe("a client that cannot list roots", () => {
  it("is reported as a path-free method_not_found diagnostic rather than the client's error text", async () => {
    const { scratch, agyBin, stateDir } = await fixture();
    const client = await startClient({
      scratch,
      env: isolatedPluginEnv({ AGY_BIN: agyBin, AGY_PLUGIN_STATE_DIR: stateDir })
    });

    const check = await call(client, "agy_check", { includeModels: false });
    const sources = check.data.workspaceSources as WorkspaceSources;

    // The normalized code is what a caller can branch on; the raw JSON-RPC text is
    // client-specific and would be noise in the diagnostic.
    expect(sources.rootsList).toEqual({
      supported: false,
      ok: false,
      count: 0,
      errorCode: "method_not_found"
    });
    expect(JSON.stringify(sources)).not.toMatch(/-32601|Method not found/i);
  });
});

#!/usr/bin/env node
/**
 * Talk to the built server over real stdio and assert the published tool contract.
 *
 * This is the cheapest gate that catches a schema regression, and it runs without
 * the agy CLI installed: every assertion below is about what the server advertises,
 * not about what agy does. The one live step is opt-in and skipped when no binary
 * is present, so CI stays green on a machine with no Antigravity account.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(repoRoot, "plugins", "agy-plugin-codex", "dist", "server.js");

const REQUIRED_TOOLS = [
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

/** Tools that resolve central job state by id alone and must not take a workspace. */
const JOB_ID_ONLY_TOOLS = ["agy_status", "agy_result", "agy_cancel"];

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

if (!existsSync(serverPath)) {
  console.error(`Built server not found: ${serverPath}. Run npm run build first.`);
  process.exit(1);
}

const client = new Client({ name: "agy-plugin-smoke", version: "0.1.0" }, { capabilities: { roots: {} } });
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: [{ uri: pathToFileURL(repoRoot).href, name: "smoke-workspace" }]
}));

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  cwd: repoRoot,
  env: { ...process.env },
  stderr: "pipe"
});

let stderrText = "";
try {
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => {
    stderrText += String(chunk);
  });

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const name of REQUIRED_TOOLS) {
    check(byName.has(name), `missing tool ${name}`);
  }

  for (const tool of tools) {
    const properties = tool.inputSchema?.properties ?? {};
    // A binary path is never a tool parameter: AGY_BIN is the trusted channel, and a
    // caller-supplied executable path would be an arbitrary-execution surface.
    check(!("agyBin" in properties), `${tool.name} must not expose agyBin`);
  }

  for (const name of JOB_ID_ONLY_TOOLS) {
    const properties = byName.get(name)?.inputSchema?.properties ?? {};
    check(!("cwd" in properties), `${name} must not expose cwd`);
  }

  // The two review tools are described as read-only. Nothing that could widen their
  // reach may be a parameter on them, or the description would be a lie.
  for (const name of ["agy_review", "agy_adversarial_review"]) {
    const tool = byName.get(name);
    const properties = tool?.inputSchema?.properties ?? {};
    check(!("allowCodexPrivatePaths" in properties), `${name} must not expose allowCodexPrivatePaths`);
    check(
      /disposable copy/i.test(tool?.description ?? ""),
      `${name} description must say the review runs against a disposable copy`
    );
  }

  // The write-capable tools must SAY they are write-capable. This plugin invokes
  // agy 1.1.18 with permissions skipped, so a caller that assumes otherwise loses files.
  for (const name of ["agy_run", "agy_continue", "agy_rescue"]) {
    const description = byName.get(name)?.description ?? "";
    check(
      /write-capable/i.test(description),
      `${name} description must state that the run is write-capable`
    );
  }

  // Every execution tool publishes the same budget contract.
  for (const name of ["agy_run", "agy_continue", "agy_rescue", "agy_review", "agy_adversarial_review"]) {
    const timeout = byName.get(name)?.inputSchema?.properties?.timeoutMs ?? {};
    check(timeout.minimum === 10_000, `${name} timeoutMs minimum must be 10000`);
    check(timeout.maximum === 86_400_000, `${name} timeoutMs maximum must be 86400000`);
  }

  for (const name of ["agy_check", "agy_conversations", "agy_status", "agy_result"]) {
    check(byName.get(name)?.annotations?.readOnlyHint === true, `${name} must carry readOnlyHint`);
  }
  for (const name of ["agy_run", "agy_continue", "agy_rescue", "agy_cancel"]) {
    check(byName.get(name)?.annotations?.readOnlyHint !== true, `${name} must not carry readOnlyHint`);
  }
  for (const name of ["agy_status", "agy_result"]) {
    check("waitMs" in (byName.get(name)?.inputSchema?.properties ?? {}), `${name} must expose waitMs`);
  }

  if (failures.length) {
    console.error("MCP smoke failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`MCP smoke passed: ${tools.length} tools available`);
} finally {
  await client.close().catch(() => undefined);
  if (stderrText.trim()) console.error(`server stderr:\n${stderrText.trim()}`);
}

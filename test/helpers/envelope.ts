import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAgyDiscoveryCache } from "../../plugins/agy-plugin-codex/src/agy-cli.js";
import { resetCheckCache } from "../../plugins/agy-plugin-codex/src/check-cache.js";

/**
 * Read a tool envelope as one flat object.
 *
 * The wire shape is `{ ok, error?, warnings, <legacy scalar mirrors>, data }`, and
 * the payload lives in `data`. Tests merge it so an assertion names a field rather
 * than a position; the wire shape itself is asserted directly in
 * test/envelope-shape.test.ts.
 */
export function readEnvelope<T = Record<string, unknown>>(result: { structuredContent: unknown }): T {
  const envelope = result.structuredContent as Record<string, unknown> & {
    data?: Record<string, unknown>;
  };
  return { ...(envelope.data ?? {}), ...envelope } as T;
}

export type ToolErrorShape = { code: string; message: string; retryable: boolean; details?: unknown };

/**
 * A boundary refusal is a returned envelope with a stable code, not an exception:
 * an MCP exception carries no code and no `retryable`.
 */
export async function refusalOf(
  run: () => Promise<{ structuredContent: unknown }>
): Promise<ToolErrorShape> {
  const envelope = (await run()).structuredContent as { ok: boolean; error?: ToolErrorShape };
  if (envelope.ok !== false || !envelope.error) {
    throw new Error(`Expected a refusal envelope, got ${JSON.stringify(envelope).slice(0, 300)}`);
  }
  return envelope.error;
}

/**
 * Run `body` with a fake `agy` on AGY_BIN.
 *
 * The tool schemas deliberately never accept a binary path, so the trusted
 * `AGY_BIN` environment variable -- the same one the shipped .mcp.json allowlists
 * -- is the only injection point. The fake always answers `--version` first,
 * because discovery probes it before anything else and a fake that does not answer
 * is recorded as `cli_probe_timeout` rather than used.
 *
 * Both process-lifetime memos are reset on entry and exit. Forgetting one leaks a
 * remembered binary or model listing into the next test.
 */
export async function withFakeAgy<T>(body: string, run: (binPath: string) => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "agy-plugin-codex-fake-"));
  const previous = process.env.AGY_BIN;
  try {
    const bin = join(binDir, "fake-agy.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === '--version') { console.log('1.1.16'); process.exit(0); }",
        body
      ].join("\n")
    );
    await chmod(bin, 0o755);
    process.env.AGY_BIN = bin;
    resetAgyDiscoveryCache();
    resetCheckCache();
    return await run(bin);
  } finally {
    if (previous === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = previous;
    resetAgyDiscoveryCache();
    resetCheckCache();
    await rm(binDir, { recursive: true, force: true });
  }
}

/** A fake that records its own argv to a file, so a test can assert the flag vector. */
export const RECORDING_FAKE = `
import { appendFileSync } from "node:fs";
if (process.env.FAKE_INVOCATIONS) {
  appendFileSync(process.env.FAKE_INVOCATIONS, JSON.stringify(process.argv.slice(2)) + "\\n");
}
if (process.argv[2] === "models") {
  process.stdout.write("Fetching available models...\\ngemini-3.7-flash-low\\tGemini 3.7 Flash (Low)\\n");
  process.exit(0);
}
const cid = process.env.FAKE_CONVERSATION_ID ?? "11111111-2222-4333-8444-555555555555";
process.stdout.write(JSON.stringify({ event: "init", conversation_id: cid, init: { model: "gemini-3.7-flash-low", cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } }) + "\\n");
process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: cid, status: "SUCCESS", response: process.env.FAKE_RESPONSE ?? "done", duration_seconds: 0.1, num_turns: 1 } }) + "\\n");
process.exit(0);
`;

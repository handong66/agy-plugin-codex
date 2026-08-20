#!/usr/bin/env node
/**
 * One real agy run through the built MCP server, in a throwaway git repository.
 *
 * Opt-in and never part of `npm run check`: it spends the user's Antigravity quota.
 * What it proves that no fake can: that `--add-dir` really targets the workspace
 * (agy is asked to read a file only this repository has), that the stream parses,
 * and that a read-only review leaves the repository untouched.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(repoRoot, "plugins", "agy-plugin-codex", "dist", "server.js");

const probe = spawnSync(process.env.AGY_BIN ?? "agy", ["--version"], { encoding: "utf8", timeout: 30_000 });
if (probe.error || probe.status !== 0) {
  console.error("agy is not runnable; skipping the live smoke.");
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "agy-live-smoke-"));
const SENTINEL = `agy-live-smoke-${Date.now()}`;
const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });

let client;
try {
  git("init", "-q");
  git("config", "user.email", "smoke@example.invalid");
  git("config", "user.name", "smoke");
  writeFileSync(join(workspace, "sentinel.txt"), `${SENTINEL}\n`);
  git("add", ".");
  git("commit", "-qm", "sentinel");

  client = new Client({ name: "agy-live-smoke", version: "0.1.0" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(workspace).href, name: "live-smoke-workspace" }]
  }));
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [serverPath],
      cwd: mkdtempSync(join(tmpdir(), "agy-live-smoke-cwd-")),
      env: { ...process.env },
      stderr: "pipe"
    })
  );

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 280_000 });
    const envelope = result.structuredContent ?? {};
    return { ...(envelope.data ?? {}), ...envelope };
  };

  const check = await call("agy_check", { cwd: workspace });
  if (!check.ok) throw new Error(`agy_check failed: ${JSON.stringify(check.error)}`);
  console.log(`agy ${check.version}, ${check.models?.length ?? 0} models, signedIn=${check.signedIn}`);

  const started = await call("agy_run", {
    cwd: workspace,
    prompt: "Read sentinel.txt and reply with only its exact contents. Do not create or modify any file.",
    model: "gemini-3.7-flash-low",
    timeoutMs: 180_000
  });
  if (!started.ok) throw new Error(`agy_run failed: ${JSON.stringify(started.error)}`);

  const result = await call("agy_result", { jobId: started.job.id, waitMs: 240_000, view: "final" });
  const summary = result.outputSummary ?? {};
  console.log(`state=${summary.state} tools=${summary.toolCallCount} model=${summary.observedModel}`);
  console.log(`finalText: ${JSON.stringify((summary.finalText ?? "").slice(0, 200))}`);

  // The point of the whole run: agy could only have produced this string by reading
  // a file that exists nowhere but the workspace it was given.
  if (!(summary.finalText ?? "").includes(SENTINEL)) {
    throw new Error("agy did not report the sentinel, so --add-dir did not target the workspace.");
  }
  if (summary.resultComplete !== true) throw new Error("run did not reach resultComplete");

  const review = await call("agy_review", {
    cwd: workspace,
    target: "sentinel.txt",
    model: "gemini-3.7-flash-low",
    timeoutMs: 180_000
  });
  if (!review.ok) throw new Error(`agy_review failed: ${JSON.stringify(review.error)}`);
  const reviewResult = await call("agy_result", { jobId: review.job.id, waitMs: 240_000, view: "final" });
  console.log(`review state=${reviewResult.outputSummary?.state} isolation=${JSON.stringify(reviewResult.record?.isolation ?? {})}`);

  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).trim();
  if (dirty) throw new Error(`read-only review modified the repository:\n${dirty}`);

  console.log("live agy smoke passed");
} finally {
  await client?.close().catch(() => undefined);
  rmSync(workspace, { recursive: true, force: true });
}

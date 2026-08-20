#!/usr/bin/env node
/**
 * Exercise every tool against the real agy CLI, through the real MCP server.
 *
 * `live-agy-smoke.mjs` proves the one thing a fake cannot: that `--add-dir`
 * actually targets the workspace. This script is the wider pass -- it drives the
 * tools the fast smoke does not reach, including the two guards that exist because
 * agy fails silently:
 *
 *   - a resume onto an unknown conversation id, which agy answers with exit 0 and
 *     SUCCESS from a conversation that has none of the context;
 *   - a read-only review, checked afterwards against the real tree.
 *
 * Opt-in and never part of `npm run check`: it spends the user's Antigravity quota.
 * Every prompt is deliberately tiny and pinned to the cheapest model.
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
const MODEL = process.env.AGY_LIVE_MODEL ?? "gemini-3.7-flash-low";
const BUDGET_MS = 180_000;

const probe = spawnSync(process.env.AGY_BIN ?? "agy", ["--version"], {
  encoding: "utf8",
  timeout: 30_000
});
if (probe.error || probe.status !== 0) {
  console.error("agy is not runnable; skipping the live pass.");
  process.exit(1);
}

const results = [];
let failures = 0;
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const workspace = mkdtempSync(join(tmpdir(), "agy-live-full-"));
const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
const SENTINEL = `agy-live-full-${Date.now()}`;

let client;
try {
  git("init", "-q");
  git("config", "user.email", "smoke@example.invalid");
  git("config", "user.name", "smoke");
  writeFileSync(join(workspace, "sentinel.txt"), `${SENTINEL}\n`);
  writeFileSync(
    join(workspace, "calc.py"),
    "def add(a, b):\n    return a - b  # this subtracts\n"
  );
  git("add", ".");
  git("commit", "-qm", "seed");

  client = new Client({ name: "agy-live-full", version: "0.1.0" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(workspace).href, name: "live-full-workspace" }]
  }));
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [serverPath],
      cwd: mkdtempSync(join(tmpdir(), "agy-live-full-cwd-")),
      env: { ...process.env },
      stderr: "pipe"
    })
  );

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 280_000 });
    const envelope = result.structuredContent ?? {};
    return { ...(envelope.data ?? {}), ...envelope };
  };
  const finish = async (jobId) =>
    await call("agy_result", { jobId, waitMs: 240_000, view: "final" });

  // ---- agy_run, foreground -------------------------------------------------
  const fg = await call("agy_run", {
    cwd: workspace,
    prompt: "Reply with exactly the word READY. Do not use any tools.",
    model: MODEL,
    background: false,
    timeoutMs: 120_000
  });
  record(
    "agy_run background:false returns an answer inline",
    fg.ok === true && (fg.outputSummary?.finalText ?? "").includes("READY"),
    `state=${fg.outputSummary?.state} model=${fg.outputSummary?.observedModel}`
  );

  // ---- agy_run, background, and the conversation handle ---------------------
  const started = await call("agy_run", {
    cwd: workspace,
    prompt: `Read sentinel.txt and reply with only its exact contents.`,
    model: MODEL,
    timeoutMs: BUDGET_MS
  });
  const jobId = started.job?.id;
  const status = await call("agy_status", { jobId, waitMs: 240_000 });
  const run = await finish(jobId);
  const conversationId = run.record?.agyConversationId;
  record(
    "agy_run background reads the workspace and reaches resultComplete",
    run.outputSummary?.resultComplete === true &&
      (run.outputSummary?.finalText ?? "").includes(SENTINEL),
    `tools=${run.outputSummary?.toolCallCount} files=${run.outputSummary?.filesInspected}`
  );
  record(
    "agy_status reports the job terminal and hands back the resume handle",
    status.terminal === true && Boolean(conversationId),
    `conversation=${conversationId}`
  );

  // ---- agy_continue, real resume -------------------------------------------
  const resumed = await call("agy_continue", {
    cwd: workspace,
    conversationId,
    prompt: "What file did you just read? Reply with only its name.",
    model: MODEL,
    timeoutMs: BUDGET_MS
  });
  const resumedResult = await finish(resumed.job.id);
  record(
    "agy_continue carries the earlier context",
    (resumedResult.outputSummary?.finalText ?? "").includes("sentinel"),
    `finalText=${JSON.stringify((resumedResult.outputSummary?.finalText ?? "").slice(0, 60))}`
  );

  // ---- agy_continue onto an id that does not exist -------------------------
  // The guard that matters most: agy answers this with exit 0 and SUCCESS from a
  // brand-new conversation, so without the id comparison the caller would trust an
  // answer produced with none of the context it believes it has.
  const bogus = await call("agy_continue", {
    cwd: workspace,
    conversationId: "00000000-0000-4000-8000-000000000000",
    prompt: "What file did you just read? Reply with only its name.",
    model: MODEL,
    timeoutMs: BUDGET_MS
  });
  const bogusResult = await finish(bogus.job.id);
  const warned = (bogusResult.warnings ?? []).join(" ");
  record(
    "agy_continue detects a conversation agy could not resume",
    warned.includes("conversation_not_found"),
    warned.includes("conversation_not_found") ? "warning raised" : `warnings=${JSON.stringify(warned.slice(0, 120))}`
  );

  // ---- agy_review, isolated -------------------------------------------------
  const review = await call("agy_review", {
    cwd: workspace,
    target: "calc.py",
    model: MODEL,
    timeoutMs: BUDGET_MS
  });
  const reviewResult = await finish(review.job.id);
  const reviewText = reviewResult.outputSummary?.finalText ?? "";
  record(
    "agy_review runs isolated and cites the real repository path",
    reviewResult.outputSummary?.state === "succeeded_with_text" && !reviewText.includes("/agy-review-"),
    `tools=${reviewResult.outputSummary?.toolCallCount} isolation=${JSON.stringify(reviewResult.record?.isolation ?? {})}`
  );

  // ---- agy_adversarial_review, isolated, with a threat model ---------------
  const adversarial = await call("agy_adversarial_review", {
    cwd: workspace,
    target: "calc.py",
    threatModel: "single-user local script, no network exposure",
    model: MODEL,
    timeoutMs: BUDGET_MS
  });
  const adversarialResult = await finish(adversarial.job.id);
  record(
    "agy_adversarial_review runs isolated",
    adversarialResult.outputSummary?.state === "succeeded_with_text",
    `tools=${adversarialResult.outputSummary?.toolCallCount} isolation=${JSON.stringify(adversarialResult.record?.isolation ?? {})}`
  );

  // ---- agy_rescue -----------------------------------------------------------
  const rescue = await call("agy_rescue", {
    cwd: workspace,
    problem: "calc.py's add() returns the wrong number. Diagnose it in one sentence.",
    model: MODEL,
    timeoutMs: BUDGET_MS
  });
  const rescueResult = await finish(rescue.job.id);
  record(
    "agy_rescue produces a diagnosis",
    rescueResult.outputSummary?.resultComplete === true,
    `tools=${rescueResult.outputSummary?.toolCallCount}`
  );

  // ---- agy_cancel -----------------------------------------------------------
  const doomed = await call("agy_run", {
    cwd: workspace,
    prompt: "Count slowly from 1 to 500 in words, one per line.",
    model: MODEL,
    timeoutMs: BUDGET_MS
  });
  const cancelled = await call("agy_cancel", { jobId: doomed.job.id });
  const afterCancel = await call("agy_status", { jobId: doomed.job.id });
  record(
    "agy_cancel ends a running job and the record stays cancelled",
    cancelled.job?.status === "cancelled" && afterCancel.job?.status === "cancelled",
    `terminal=${afterCancel.terminal}`
  );

  // ---- agy_conversations ----------------------------------------------------
  const conversations = await call("agy_conversations", { cwd: workspace, limit: 20 });
  const listed = (conversations.conversations ?? []).map((c) => c.conversationId);
  record(
    "agy_conversations lists the conversations this run created",
    conversations.ok === true && listed.includes(conversationId),
    `returned=${conversations.returned} scanned=${conversations.scanned}`
  );

  // ---- the repository is untouched -----------------------------------------
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8"
  }).trim();
  record(
    "both read-only reviews left the repository byte-identical",
    dirty === "",
    dirty === "" ? "git status clean" : `git status:\n${dirty}`
  );
} finally {
  await client?.close().catch(() => undefined);
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\n${results.length - failures}/${results.length} checks passed against real agy.`);
process.exit(failures ? 1 : 0);

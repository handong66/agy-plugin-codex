import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PROMPT_BYTES } from "../plugins/agy-plugin-codex/src/agy-cli.js";
import {
  JobStore,
  WORKSPACE_PLACEHOLDER,
  type JobRecord
} from "../plugins/agy-plugin-codex/src/job-store.js";
import {
  agyCancel,
  agyCheck,
  agyResult,
  agyReview,
  agyRun,
  agyStatus,
  configureWorkspaceRootsProvider,
  maskProxyCredentials,
  MAX_WAIT_MS
} from "../plugins/agy-plugin-codex/src/tools.js";
import { RECORDING_FAKE, readEnvelope, refusalOf, withFakeAgy } from "./helpers/envelope.js";

/**
 * In-process tests of the exported tool functions.
 *
 * Everything the tools reach outside this process is pinned: the workspace roots
 * come from an injected provider, the CLI comes from AGY_BIN, and the job state
 * comes from AGY_PLUGIN_STATE_DIR. The measured agy behaviours these tests protect
 * are in docs/AGY-RUNTIME-CONTRACT.md.
 */

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The provider the module ships with, restored after every test. */
const DEFAULT_ROOTS_PROVIDER = async () => [process.cwd()];

/**
 * Every variable a test here writes, plus every proxy variable agy_check reads.
 * The proxy set is cleared rather than merely restored: a developer's real proxy
 * would otherwise show up inside the masking assertion.
 */
const MANAGED_ENV_KEYS = [
  "AGY_PLUGIN_STATE_DIR",
  "AGY_PLUGIN_WORKER_PATH",
  "AGY_WORKSPACE_ROOTS",
  "CODEX_SECRET",
  "CODEX_THREAD_ID",
  "CODEX_HOME",
  "FAKE_INVOCATIONS",
  "FAKE_RESPONSE",
  "FAKE_CONVERSATION_ID",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
];

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

async function makeTempDir(prefix = "agy-tools-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  // realpath because the tool resolves every root through realpath before it
  // compares paths, and macOS hands out /var/... for /private/var/...
  return await realpath(dir);
}

/** Point the tools at one workspace root and return its resolved path. */
async function useWorkspace(prefix?: string): Promise<string> {
  const root = await makeTempDir(prefix);
  configureWorkspaceRootsProvider(async () => [root]);
  return root;
}

/** A private state directory, so no test can see another test's jobs. */
async function useStateDir(): Promise<string> {
  const stateDir = await makeTempDir("agy-tools-state-");
  process.env.AGY_PLUGIN_STATE_DIR = stateDir;
  return stateDir;
}

async function useInvocationsFile(): Promise<string> {
  const dir = await makeTempDir("agy-tools-invocations-");
  const file = join(dir, "invocations.ndjson");
  await writeFile(file, "");
  process.env.FAKE_INVOCATIONS = file;
  return file;
}

type Invocations = { argv: string[][]; codexEnv: string[][] };

async function readInvocations(file: string): Promise<Invocations> {
  const raw = await readFile(file, "utf8").catch(() => "");
  const argv: string[][] = [];
  const codexEnv: string[][] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (Array.isArray(parsed)) argv.push(parsed as string[]);
    else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Invocations).codexEnv)) {
      codexEnv.push((parsed as { codexEnv: string[] }).codexEnv);
    }
  }
  return { argv, codexEnv };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * RECORDING_FAKE plus a record of the CODEX_* variables the child could see.
 *
 * The env line is written first and the argv line second, so one file carries
 * both. Both statements sit after the helper's `--version` early exit, so the
 * discovery probe never records anything.
 */
const ARGV_AND_ENV_RECORDING_FAKE = [
  'import { appendFileSync as recordEnv } from "node:fs";',
  "if (process.env.FAKE_INVOCATIONS) {",
  "  recordEnv(",
  "    process.env.FAKE_INVOCATIONS,",
  '    JSON.stringify({ codexEnv: Object.keys(process.env).filter((k) => k.startsWith("CODEX_")) }) + "\\n"',
  "  );",
  "}",
  RECORDING_FAKE
].join("\n");

/** A fake that answers with the workspace it was actually given. */
const ECHO_ADD_DIR_FAKE = `
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (process.env.FAKE_INVOCATIONS) {
  appendFileSync(process.env.FAKE_INVOCATIONS, JSON.stringify(argv) + "\\n");
}
const addDir = argv[argv.indexOf("--add-dir") + 1];
const cid = "11111111-2222-4333-8444-555555555555";
process.stdout.write(JSON.stringify({ event: "init", conversation_id: cid, init: { model: "gemini-3.7-flash-low", cwd: addDir, tools: [], permission_mode: "always-proceed" } }) + "\\n");
process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: cid, status: "SUCCESS", response: "Reviewed " + addDir + "/tracked.txt:1 -- no findings.", duration_seconds: 0.1, num_turns: 1 } }) + "\\n");
process.exit(0);
`;

/** A fake whose `models` subcommand fails, which is how agy reports "not signed in". */
const SIGNED_OUT_FAKE = `
if (process.argv[2] === "models") {
  process.stderr.write("failed to list models\\n");
  process.exit(1);
}
process.exit(1);
`;

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function gitOut(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agy-tools-repo-");
  git(repo, ["init", "-q", "-b", "main", "."]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "agy plugin test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "tracked.txt"), "committed contents\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

async function writeTerminalJob(id = "job_terminal_fixture"): Promise<JobRecord> {
  const store = new JobStore();
  const now = new Date().toISOString();
  const record: JobRecord = {
    id,
    kind: "run",
    status: "succeeded",
    cwd: store.stateDir,
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

describe("the argv agy actually receives", () => {
  it("puts -p and the prompt first, names the resolved cwd with --add-dir, and asks for stream-json", async () => {
    const workspace = await useWorkspace();
    const invocations = await useInvocationsFile();

    const envelope = await withFakeAgy(ARGV_AND_ENV_RECORDING_FAKE, () =>
      agyRun({ prompt: "count the files", cwd: workspace, background: false, timeoutMs: 60_000 })
    );

    expect(readEnvelope<{ ok: boolean }>(envelope).ok).toBe(true);
    const { argv } = await readInvocations(invocations);
    expect(argv).toHaveLength(1);
    const flags = argv[0];

    // agy takes its prompt as the value of -p; there is no stdin path, so the
    // prompt has to lead the argv.
    expect(flags[0]).toBe("-p");
    expect(flags[1]).toBe("count the files");
    // --add-dir is the ONLY thing that decides what a run can see: agy ignores the
    // process working directory entirely (AGY-RUNTIME-CONTRACT.md §2).
    expect(flagValue(flags, "--add-dir")).toBe(workspace);
    // In agy 1.1.18 E1, a denied tool call terminated the run and cleared its
    // answer; this flag avoids that permission gate (§3).
    expect(flags).toContain("--dangerously-skip-permissions");
    // stream-json is the only format whose init event names the model that ran and
    // whose step_update events name each tool call (§5, §5a).
    expect(flagValue(flags, "--output-format")).toBe("stream-json");
    // A prompt may legitimately begin with a slash; without this agy reinterprets
    // it as one of its own slash commands.
    expect(flags).toContain("--disable-slash-commands");
  });

  it("passes --mode accept-edits for a direct write-capable run", async () => {
    const workspace = await useWorkspace();
    const invocations = await useInvocationsFile();

    await withFakeAgy(ARGV_AND_ENV_RECORDING_FAKE, () =>
      agyRun({ prompt: "edit something", cwd: workspace, background: false, timeoutMs: 60_000 })
    );

    const { argv } = await readInvocations(invocations);
    expect(flagValue(argv[0], "--mode")).toBe("accept-edits");
  });

  it("hands the child no CODEX_* variable at all", async () => {
    const workspace = await useWorkspace();
    const invocations = await useInvocationsFile();
    process.env.CODEX_SECRET = "codex-private-value";

    await withFakeAgy(ARGV_AND_ENV_RECORDING_FAKE, () =>
      agyRun({ prompt: "hello", cwd: workspace, background: false, timeoutMs: 60_000 })
    );

    const { codexEnv } = await readInvocations(invocations);
    expect(codexEnv).toHaveLength(1);
    // agy is a separate agent with its own account and state directory; inheriting
    // CODEX_* would hand it Codex-private context it has no reason to see.
    expect(codexEnv[0]).toEqual([]);
  });
});

describe.skipIf(!hasGit)("agy_review points agy at a disposable copy, never the repository", () => {
  it("gives --add-dir a path outside the repository, leaves the repository byte-identical, and deletes the copy", async () => {
    const repo = await makeRepo();
    configureWorkspaceRootsProvider(async () => [repo]);
    const invocations = await useInvocationsFile();
    const before = await readFile(join(repo, "tracked.txt"), "utf8");

    const result = await withFakeAgy(ARGV_AND_ENV_RECORDING_FAKE, () =>
      agyReview({ target: "the working tree", cwd: repo, background: false, timeoutMs: 60_000 })
    );

    const { argv } = await readInvocations(invocations);
    const addDir = flagValue(argv[0], "--add-dir") as string;
    // A surviving placeholder would satisfy "not the repository" without isolating
    // anything, so the value has to be a real absolute path of its own.
    expect(addDir).not.toBe(WORKSPACE_PLACEHOLDER);
    expect(isAbsolute(addDir)).toBe(true);
    // agy 1.1.18 E1 showed that a permission denial terminates a run and clears its
    // answer (§3); the mirror avoids that gate, so the repository path must not leak.
    expect(addDir).not.toBe(repo);
    expect(addDir.startsWith(`${repo}${sep}`)).toBe(false);
    // --mode accept-edits is deliberately absent on a review; the copy is what makes
    // it read-only, not a flag.
    expect(argv[0]).not.toContain("--mode");

    expect(gitOut(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe(before);
    // The copy is cleaned up in a finally, so it is gone by the time the call
    // returns rather than at some later point.
    expect(existsSync(addDir)).toBe(false);
    expect(readEnvelope<{ ok: boolean }>(result).ok).toBe(true);
  });

  it("rewrites the disposable copy's path out of the answer, so findings cite paths the user can open", async () => {
    const repo = await makeRepo();
    configureWorkspaceRootsProvider(async () => [repo]);
    const invocations = await useInvocationsFile();

    const result = await withFakeAgy(ECHO_ADD_DIR_FAKE, () =>
      agyReview({ target: "tracked.txt", cwd: repo, background: false, timeoutMs: 60_000 })
    );

    const { argv } = await readInvocations(invocations);
    const mirrorPath = flagValue(argv[0], "--add-dir") as string;
    const envelope = readEnvelope<{ outputSummary: { finalText?: string } }>(result);
    const finalText = envelope.outputSummary.finalText ?? "";

    expect(finalText).toContain(`${repo}/tracked.txt`);
    // The copy stops existing when the run ends, so a finding that cites it names a
    // path the user cannot open.
    expect(finalText).not.toContain(mirrorPath);
  });

  it("refuses a review outside a git repository with mirror_failed and never starts agy", async () => {
    const workspace = await useWorkspace("agy-tools-not-a-repo-");
    const invocations = await useInvocationsFile();

    const error = await withFakeAgy(ARGV_AND_ENV_RECORDING_FAKE, () =>
      refusalOf(() => agyReview({ cwd: workspace, background: false, timeoutMs: 60_000 }))
    );

    expect(error.code).toBe("mirror_failed");
    expect(error.retryable).toBe(false);
    // There is no weaker version of the guarantee to fall back to, so nothing runs
    // at all rather than the review running against the real tree.
    expect(await readInvocations(invocations)).toEqual({ argv: [], codexEnv: [] });
  });
});

describe("workspace validation happens before the spawn", () => {
  it("refuses a cwd that does not exist and never starts agy", async () => {
    const workspace = await useWorkspace();
    const invocations = await useInvocationsFile();

    const error = await withFakeAgy(ARGV_AND_ENV_RECORDING_FAKE, () =>
      refusalOf(() =>
        agyRun({
          prompt: "hello",
          cwd: join(workspace, "no-such-directory"),
          background: false,
          timeoutMs: 60_000
        })
      )
    );

    expect(error.code).toBe("workspace_out_of_bounds");
    // agy silently ignores a bad --add-dir: it exits 0, reports SUCCESS, writes
    // nothing to stderr and runs inside ~/.gemini/antigravity-cli instead
    // (AGY-RUNTIME-CONTRACT.md §9). Nothing in the run's output distinguishes that
    // from a real run, so this check is the only place the mistake can be caught.
    expect(await readInvocations(invocations)).toEqual({ argv: [], codexEnv: [] });
  });

  it("refuses a cwd outside the configured roots and names the roots", async () => {
    const workspace = await useWorkspace();
    const outside = await makeTempDir("agy-tools-outside-");

    const error = await refusalOf(() =>
      agyRun({ prompt: "hello", cwd: outside, background: false, timeoutMs: 60_000 })
    );

    expect(error.code).toBe("workspace_out_of_bounds");
    expect(error.message).toContain(outside);
    expect(error.message).toContain(workspace);
  });

  it("refuses with workspace_unavailable when no root exists at all, because agy has no process-cwd fallback", async () => {
    configureWorkspaceRootsProvider(async () => []);

    const error = await refusalOf(() => agyRun({ prompt: "hello", background: false }));

    expect(error.code).toBe("workspace_unavailable");
    expect(error.retryable).toBe(false);
    // Measured: a run with no --add-dir operates inside ~/.gemini/antigravity-cli
    // and sees none of the repository, so this is fatal rather than degraded.
    expect(error.message).toMatch(/ignores the process working directory/i);
    expect(error.message).toContain("--add-dir");
  });
});

describe("the prompt boundary", () => {
  it("refuses a prompt naming ~/.codex, reporting an offset and a home-masked preview", async () => {
    const workspace = await useWorkspace();
    const home = homedir();

    const error = await refusalOf(() =>
      agyRun({
        prompt: `Read ${home}/.codex/sessions/rollout.jsonl and summarise the last turn.`,
        cwd: workspace,
        background: false
      })
    );

    expect(error.code).toBe("private_path_blocked");
    expect(error.message).toMatch(/First match at character \d+/);
    expect(error.message).toContain("~/.codex");
    // The refusal is persisted in the transcript, so it must not echo an absolute
    // user path back into it.
    expect(error.message).not.toContain(home);
    expect(JSON.stringify(error)).not.toContain(home);
  });

  it("lets the same prompt through when allowCodexPrivatePaths is set", async () => {
    const workspace = await useWorkspace();
    const home = homedir();

    const result = await withFakeAgy(RECORDING_FAKE, () =>
      agyRun({
        prompt: `Read ${home}/.codex/sessions/rollout.jsonl and summarise the last turn.`,
        cwd: workspace,
        background: false,
        timeoutMs: 60_000,
        allowCodexPrivatePaths: true
      })
    );

    expect(readEnvelope<{ ok: boolean }>(result).ok).toBe(true);
  });

  it("measures prompt_too_large in BYTES, not characters, and names both numbers", async () => {
    const workspace = await useWorkspace();
    // Three UTF-8 bytes per character: a character-based limit would have let this
    // through, and spawn would then have failed with a bare E2BIG.
    const prompt = "漢".repeat(200_000);
    expect(prompt.length).toBeLessThan(MAX_PROMPT_BYTES);

    const error = await refusalOf(() =>
      agyRun({ prompt, cwd: workspace, background: false })
    );

    expect(error.code).toBe("prompt_too_large");
    expect(error.message).toContain("600000");
    expect(error.message).toContain(String(MAX_PROMPT_BYTES));
  });
});

describe("the model guard", () => {
  it("refuses an unlisted model id before any run, once a check has cached the listing", async () => {
    const workspace = await useWorkspace();

    await withFakeAgy(RECORDING_FAKE, async () => {
      const check = readEnvelope<{ ok: boolean; models: string[] }>(
        await agyCheck({ cwd: workspace })
      );
      expect(check.ok).toBe(true);
      expect(check.models).toContain("gemini-3.7-flash-low");

      const invocations = await useInvocationsFile();
      const error = await refusalOf(() =>
        agyRun({
          prompt: "hello",
          cwd: workspace,
          model: "gemini-9.9-imaginary",
          background: false,
          timeoutMs: 60_000
        })
      );

      expect(error.code).toBe("model_not_found");
      expect(error.message).toContain("gemini-3.7-flash-low");
      // agy's own error for a bad model prints DISPLAY names while --model takes
      // ids, so the refusal has to hand back ids.
      expect(await readInvocations(invocations)).toEqual({ argv: [], codexEnv: [] });
    });
  });

  it("allows any model when no listing has been cached, because an unsure parse must not refuse the caller's work", async () => {
    const workspace = await useWorkspace();
    const invocations = await useInvocationsFile();

    const result = await withFakeAgy(ARGV_AND_ENV_RECORDING_FAKE, () =>
      agyRun({
        prompt: "hello",
        cwd: workspace,
        model: "totally-made-up-model",
        background: false,
        timeoutMs: 60_000
      })
    );

    expect(readEnvelope<{ ok: boolean }>(result).ok).toBe(true);
    const { argv } = await readInvocations(invocations);
    expect(flagValue(argv[0], "--model")).toBe("totally-made-up-model");
  });
});

describe("agy_check", () => {
  it("reports auth_required when the model listing fails, because agy has no auth subcommand", async () => {
    const workspace = await useWorkspace();

    const result = await withFakeAgy(SIGNED_OUT_FAKE, () => agyCheck({ cwd: workspace }));
    const envelope = readEnvelope<{
      ok: boolean;
      error?: { code: string; retryable: boolean };
      signedIn: boolean;
    }>(result);

    expect(envelope.ok).toBe(false);
    // The model listing is a real backend call and the cheapest observable proof of
    // a working Google sign-in; anything stronger would cost a model turn.
    expect(envelope.error?.code).toBe("auth_required");
    expect(envelope.error?.retryable).toBe(true);
    expect(envelope.signedIn).toBe(false);
  });

  it("returns the parsed model ids when the listing succeeds", async () => {
    const workspace = await useWorkspace();

    const result = await withFakeAgy(RECORDING_FAKE, () => agyCheck({ cwd: workspace }));
    const envelope = readEnvelope<{ ok: boolean; models: string[]; modelLines: string[] }>(result);

    expect(envelope.ok).toBe(true);
    // The ids are the left column. The human progress line agy prints first is not
    // a model (AGY-RUNTIME-CONTRACT.md §12).
    expect(envelope.models).toEqual(["gemini-3.7-flash-low"]);
    expect(envelope.modelLines.some((line) => line.startsWith("Fetching"))).toBe(false);
  });

  it("still returns CLI and version diagnostics when no workspace is available, while execution tools refuse", async () => {
    configureWorkspaceRootsProvider(async () => []);

    await withFakeAgy(RECORDING_FAKE, async (binPath) => {
      const check = readEnvelope<{
        ok: boolean;
        agyBin: string;
        version: string;
        workspace: { ok: boolean; error: { code: string } };
        warnings: string[];
      }>(await agyCheck({}));

      // A missing workspace root must not hide information that has nothing to do
      // with the workspace: that is exactly when a caller needs it.
      expect(check.ok).toBe(true);
      expect(check.agyBin).toBe(binPath);
      expect(check.version).toBe("1.1.16");
      expect(check.workspace.ok).toBe(false);
      expect(check.workspace.error.code).toBe("workspace_unavailable");
      expect(check.warnings.join(" ")).toMatch(/every execution tool will refuse/i);

      // Diagnostics degrade; execution stays fail-closed.
      const error = await refusalOf(() => agyRun({ prompt: "hello", background: false }));
      expect(error.code).toBe("workspace_unavailable");
    });
  });

  it("masks proxy credentials, because the answer is persisted in the transcript", async () => {
    const workspace = await useWorkspace();
    process.env.HTTPS_PROXY = "http://user:secret@proxy:3128";

    const result = await withFakeAgy(RECORDING_FAKE, () => agyCheck({ cwd: workspace }));
    const envelope = readEnvelope<{ proxy: Record<string, string> }>(result);

    expect(envelope.proxy.HTTPS_PROXY).toBe("http://***@proxy:3128");
    expect(JSON.stringify(result.structuredContent)).toContain("***@");
    expect(JSON.stringify(result.structuredContent)).not.toContain("secret");
  });
});

describe("maskProxyCredentials", () => {
  it("hides the userinfo of a proxy URL", () => {
    expect(maskProxyCredentials("http://u:p@h:3128")).toBe("http://***@h:3128");
  });

  it("hides the userinfo of a scheme-less proxy value", () => {
    expect(maskProxyCredentials("u:p@h:3128")).toBe("***@h:3128");
  });

  it("leaves a URL with no userinfo unchanged", () => {
    expect(maskProxyCredentials("http://proxy.example.invalid:3128")).toBe(
      "http://proxy.example.invalid:3128"
    );
  });
});

describe("background submission", () => {
  it("returns a jobId and a projected job that carries no argv, pid or log path", async () => {
    const workspace = await useWorkspace();
    await useStateDir();

    const result = await withFakeAgy(RECORDING_FAKE, () =>
      agyRun({ prompt: "hello", cwd: workspace, background: true, timeoutMs: 60_000 })
    );
    const envelope = readEnvelope<{
      ok: boolean;
      background: boolean;
      job: Record<string, unknown>;
    }>(result);

    expect(envelope.ok).toBe(true);
    expect(envelope.background).toBe(true);
    expect(envelope.job.id).toMatch(/^job_[A-Za-z0-9_-]+$/);
    // The projection is an allowlist, never a spread. The argv in particular carries
    // the disposable mirror's path, which a read-only review must not hand back.
    for (const field of ["command", "args", "pid", "workerPid", "stdoutPath", "stderrPath"]) {
      expect(envelope.job).not.toHaveProperty(field);
    }
  });
});

describe("job observation tools", () => {
  it("answers an unknown jobId with a typed job_not_found refusal rather than throwing", async () => {
    await useStateDir();

    for (const call of [
      () => agyStatus({ jobId: "job_does_not_exist" }),
      () => agyResult({ jobId: "job_does_not_exist" }),
      () => agyCancel({ jobId: "job_does_not_exist" })
    ]) {
      const error = await refusalOf(call);
      expect(error.code).toBe("job_not_found");
      expect(error.retryable).toBe(false);
      // This is the one call a caller makes because it lost its handle, so the
      // refusal must not answer with a raw ENOENT carrying the state directory.
      expect(error.message).not.toContain(process.env.AGY_PLUGIN_STATE_DIR as string);
    }
  });

  it("warns on cancel that cancelling abandons the conversation a timeout would keep", async () => {
    await useStateDir();
    const job = await writeTerminalJob("job_cancel_fixture");

    const result = await agyCancel({ jobId: job.id });
    const envelope = readEnvelope<{ warnings: string[] }>(result);

    expect(envelope.warnings.join(" ")).toMatch(/Cancelling abandons the agy conversation/i);
    expect(envelope.warnings.join(" ")).toMatch(/agy_continue/);
  });

  it("returns immediately when waitMs is omitted", async () => {
    await useStateDir();
    const job = await writeTerminalJob("job_wait_default");

    const envelope = readEnvelope<{ waited: number }>(await agyResult({ jobId: job.id }));

    expect(envelope.waited).toBe(0);
  });

  it("clamps a waitMs above the ceiling and says so in warnings", async () => {
    await useStateDir();
    const job = await writeTerminalJob("job_wait_clamped");

    const envelope = readEnvelope<{ waited: number; warnings: string[] }>(
      await agyResult({ jobId: job.id, waitMs: 300_000 })
    );

    // Codex aborts a tools/call at 300s, so a longer server-side wait would lose the
    // call rather than return the record.
    expect(envelope.warnings.join(" ")).toContain(String(MAX_WAIT_MS));
    expect(envelope.warnings.join(" ")).toContain("300000");
    expect(envelope.waited).toBeLessThan(1_000);
  });
});

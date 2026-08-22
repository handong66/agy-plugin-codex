import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";
import { BoundaryError } from "./boundary.js";

/**
 * The agy runtime adapter.
 *
 * Every behavioural claim in this file was measured against the real CLI and is
 * written up in docs/AGY-RUNTIME-CONTRACT.md with the probe command that produced
 * it. Nothing here is carried over by analogy from the OpenCode or Grok plugins
 * this project's structure comes from: agy's headless mode differs from both in two
 * ways that break an integration built by analogy, and both are load-bearing here.
 */

export type DiscoverAgyOptions = {
  agyBin?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  extraCandidates?: string[];
  /** Skip the process-lifetime memo and re-probe. */
  force?: boolean;
};

export type DiscoverAgyResult = {
  ok: boolean;
  bin?: string;
  version?: string;
  tried: string[];
  errors: string[];
  /** How the binary was chosen: trusted explicitly, probed, or remembered. */
  source?: "explicit" | "probe" | "cache";
  /**
   * `cli_not_found` when nothing was executable, `cli_probe_timeout` when a
   * candidate existed but never answered `--version` inside the probe budget.
   */
  errorCode?: "cli_not_found" | "cli_probe_timeout";
  cachedAt?: string;
};

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxOutputChars?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

function appendOutputTail(
  current: string,
  chunk: string,
  maxChars: number
): { value: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= maxChars) return { value: combined, truncated: false };
  return { value: combined.slice(-maxChars), truncated: true };
}

/**
 * Codex's own runtime variables are removed before agy is spawned. agy is a
 * separate agent with its own account and its own state directory; inheriting
 * `CODEX_*` would hand it Codex-private context it has no reason to see.
 */
export function sanitizeAgyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => value !== undefined && !name.startsWith("CODEX_"))
  ) as NodeJS.ProcessEnv;
}

export function expandHome(value: string, homeDir = homedir()): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function getAgyCandidates(options: DiscoverAgyOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const pathCandidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "agy"));

  return unique([
    options.agyBin ? expandHome(options.agyBin, home) : "",
    env.AGY_BIN ? expandHome(env.AGY_BIN, home) : "",
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    join(home, ".local", "bin", "agy"),
    ...(options.extraCandidates ?? []).map((candidate) => expandHome(candidate, home)),
    ...pathCandidates
  ]);
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal a whole process group.
 *
 * A negative pid is the group whose leader has that pid, which is why every spawn
 * on a timeout path asks for `detached` -- the child's own pid becomes a group id,
 * and one signal reaches the CLI and everything the CLI started. `pid <= 1` is
 * refused because `kill(-0, ...)` signals the caller's own group and `kill(-1, ...)`
 * signals every process the user owns. ESRCH means the group is already gone, which
 * is the outcome this asks for.
 */
function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  const startedAt = Date.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: sanitizeAgyEnv({ ...process.env, ...(options.env ?? {}) }),
      // The foreground timeout below has to reach agy's own children. Without a
      // group of its own, only the CLI pid receives the signal and every descendant
      // can outlive the deadline.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const maxOutputChars = Math.max(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, 1);
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalProcessTree(child.pid, "SIGTERM");
      // The leader exiting does not prove that descendants honoured SIGTERM, so
      // escalation must target the group even after `close` settles this run.
      setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 2_000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const appended = appendOutputTail(stdout, chunk, maxOutputChars);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendOutputTail(stderr, chunk, maxOutputChars);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      settled = true;
      resolve({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
        timedOut
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Probe budget, wide enough that a cold binary is not recorded as "not found". */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

/** Best-effort version read for a bin we already decided to trust. */
const TRUSTED_VERSION_PROBE_TIMEOUT_MS = 5_000;

type DiscoveryCacheEntry = { key: string; result: DiscoverAgyResult };

/**
 * Process-lifetime memo. Without it every call re-walks the candidate list with a
 * spawn per entry, which is how a check can report the CLI available and the very
 * next run report it missing. Only successes are remembered, and a remembered bin
 * is re-checked for existence before it is reused.
 */
let discoveryCache: DiscoveryCacheEntry | null = null;

function discoveryCacheKey(options: DiscoverAgyOptions): string {
  const env = options.env ?? process.env;
  return JSON.stringify([
    options.agyBin ?? "",
    env.AGY_BIN ?? "",
    env.PATH ?? "",
    options.homeDir ?? env.HOME ?? "",
    options.extraCandidates ?? []
  ]);
}

/** Exposed for tests and for `agy_check`'s explicit refresh. */
export function resetAgyDiscoveryCache(): void {
  discoveryCache = null;
}

async function readVersion(
  candidate: string,
  options: DiscoverAgyOptions,
  timeoutMs: number
): Promise<{ version?: string; error?: string; timedOut: boolean }> {
  try {
    const result = await runProcess(candidate, ["--version"], { env: options.env, timeoutMs });
    if (result.exitCode === 0) {
      // Measured: `agy --version` prints a bare version string ("1.1.16") with no
      // product name around it.
      return { version: result.stdout.trim() || result.stderr.trim(), timedOut: false };
    }
    return {
      error: `${candidate}: --version exited ${result.exitCode ?? "null"}${result.timedOut ? " (probe timed out)" : ""}: ${result.stderr.trim()}`,
      timedOut: result.timedOut === true
    };
  } catch (error) {
    return {
      error: `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false
    };
  }
}

export async function discoverAgy(options: DiscoverAgyOptions = {}): Promise<DiscoverAgyResult> {
  const key = discoveryCacheKey(options);
  if (!options.force && discoveryCache?.key === key && discoveryCache.result.bin) {
    if (await isExecutable(discoveryCache.result.bin)) {
      return { ...discoveryCache.result, source: "cache" };
    }
    discoveryCache = null;
  }

  const tried: string[] = [];
  const errors: string[] = [];

  // An explicitly configured binary is a decision, not a suggestion: it is trusted
  // once it is executable, and `--version` only fills in the version string.
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const explicitBin = options.agyBin ?? env.AGY_BIN;
  if (explicitBin) {
    const candidate = expandHome(explicitBin, home);
    tried.push(candidate);
    if (await isExecutable(candidate)) {
      const probe = await readVersion(candidate, options, TRUSTED_VERSION_PROBE_TIMEOUT_MS);
      if (probe.error) errors.push(probe.error);
      const result: DiscoverAgyResult = {
        ok: true,
        bin: candidate,
        version: probe.version,
        tried,
        errors,
        source: "explicit"
      };
      // Only a complete answer is remembered. A trusted binary whose `--version`
      // failed is still usable -- an explicit AGY_BIN is a decision, not a
      // suggestion -- but memoising the versionless result would make `agy_check`
      // report a blank version for the rest of the process, even though the CLI
      // answers a second later. The same "successes only" rule the model listing
      // and every other memo in this plugin follows.
      if (probe.version !== undefined) {
        discoveryCache = { key, result: { ...result, cachedAt: new Date().toISOString() } };
      }
      return result;
    }
    errors.push(`${candidate}: not executable or not found (explicitly configured)`);
  }

  let sawProbeTimeout = false;
  for (const candidate of getAgyCandidates(options)) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (!(await isExecutable(candidate))) {
      errors.push(`${candidate}: not executable or not found`);
      continue;
    }

    const probe = await readVersion(candidate, options, VERSION_PROBE_TIMEOUT_MS);
    if (probe.version !== undefined) {
      const result: DiscoverAgyResult = {
        ok: true,
        bin: candidate,
        version: probe.version,
        tried,
        errors,
        source: "probe"
      };
      discoveryCache = { key, result: { ...result, cachedAt: new Date().toISOString() } };
      return result;
    }
    sawProbeTimeout ||= probe.timedOut;
    if (probe.error) errors.push(probe.error);
  }

  // A failure is never cached: the next call must be free to find a CLI that just
  // finished installing.
  return {
    ok: false,
    tried,
    errors,
    errorCode: sawProbeTimeout ? "cli_probe_timeout" : "cli_not_found"
  };
}

/** The typed refusal a caller sees when discovery fails. */
export function discoveryFailure(discovered: DiscoverAgyResult): BoundaryError {
  return new BoundaryError(discovered.errorCode ?? "cli_not_found", describeDiscoveryFailure(discovered), {
    tried: discovered.tried,
    errors: discovered.errors
  });
}

/** The message a caller sees when discovery fails: paths *and* reasons. */
export function describeDiscoveryFailure(discovered: DiscoverAgyResult): string {
  const reasons = discovered.errors.slice(-5);
  const code = discovered.errorCode ?? "cli_not_found";
  const headline =
    code === "cli_probe_timeout"
      ? `agy did not answer --version within ${VERSION_PROBE_TIMEOUT_MS}ms (cli_probe_timeout).`
      : "Antigravity CLI (agy) not found (cli_not_found). Install it with `brew install --cask antigravity-cli`, " +
        "or set AGY_BIN to its path.";
  return (
    `${headline} Tried: ${discovered.tried.join(", ")}` +
    (reasons.length ? `. Reasons: ${reasons.join(" | ")}` : "")
  );
}

export async function runAgy(
  args: string[],
  options: RunProcessOptions & DiscoverAgyOptions = {}
): Promise<ProcessResult & { bin: string }> {
  const discovered = await discoverAgy(options);
  if (!discovered.ok || !discovered.bin) {
    throw discoveryFailure(discovered);
  }

  const result = await runProcess(discovered.bin, args, options);
  return { ...result, bin: discovered.bin };
}

/* ------------------------------------------------------------------------- */
/* Argument construction                                                      */
/* ------------------------------------------------------------------------- */

export const EFFORT_LEVELS = new Set(["low", "medium", "high"]);

export type BuildAgyArgsParams = {
  /**
   * The directory agy is allowed to see. Never optional -- see the note below.
   *
   * For a background job this is `WORKSPACE_PLACEHOLDER`: a read-only review's
   * disposable copy does not exist until the worker builds it, so the worker
   * substitutes the real path into the recorded argv.
   */
  workspace: string;
  model?: string;
  effort?: string;
  resumeConversationId?: string;
  continueLatest?: boolean;
  /**
   * A read-only run is one whose `workspace` is a disposable copy. The flag only
   * suppresses `--mode accept-edits`; the plugin still skips permission prompts,
   * so agy 1.1.18 remains write-capable inside that disposable copy (see below).
   */
  readOnly?: boolean;
  jsonSchemaFile?: string;
  /** e.g. "600s". agy's own default is 5m0s. */
  printTimeout?: string;
};

/**
 * The flag vector for one agy run.
 *
 * Two flags here are load-bearing in a way that is not obvious and is easy to
 * "simplify" away later, so both are justified at the call site.
 *
 *   --add-dir <workspace>
 *     In the agy 1.1.16 workspace measurement, a launch without --add-dir used
 *     ~/.gemini/antigravity-cli, could not see the repository's files, and created
 *     a file in its own state directory. --add-dir is the only thing that decides
 *     what a run can see, which is also why read-only runs are handed a throwaway
 *     copy here rather than a mode flag.
 *
 *   --dangerously-skip-permissions
 *     In the agy 1.1.18 E1 measurement, any denied tool call terminated the run
 *     and cleared its answer; agy chose to deny even a read of .env, and all three
 *     no-shell runs failed. Skipping prompts avoids that fatal permission gate.
 *     Repository isolation is still done by choosing a disposable workspace.
 *
 * --mode plan is deliberately NOT used for read-only runs. Measured in agy 1.1.16,
 * plan mode refused reads and shell commands as well as writes, resolved its
 * workspace to ~/.gemini/antigravity-cli/scratch, and wrote a plan artifact while
 * waiting for an approval that never arrived in headless mode. That is a plan
 * generator, not the review path measured for agy 1.1.18.
 */
export function buildAgyArgs(params: BuildAgyArgsParams): string[] {
  if (!params.workspace) {
    throw new BoundaryError(
      "workspace_required",
      "buildAgyArgs requires a workspace: agy ignores the process working directory, so a run without --add-dir " +
        "cannot see the repository."
    );
  }

  const args: string[] = [];
  // stream-json is the only format whose `init` event names the model that actually
  // ran and whose `step_update` events name each tool call, and its final `result`
  // event carries the same object `--output-format json` would have produced. There
  // is no reason to ask for the narrower format.
  args.push("--output-format", "stream-json");
  args.push("--add-dir", params.workspace);
  args.push("--dangerously-skip-permissions");
  if (!params.readOnly) args.push("--mode", "accept-edits");

  if (params.resumeConversationId) {
    args.push("--conversation", params.resumeConversationId);
  } else if (params.continueLatest) {
    args.push("--continue");
  }
  if (params.model) args.push("--model", params.model);

  const effort = params.effort ? String(params.effort).toLowerCase() : undefined;
  // An effort agy does not accept is never put on the command line; the caller has
  // already been warned about it by resolveEffortSelection.
  if (effort && EFFORT_LEVELS.has(effort)) args.push("--effort", effort);

  if (params.jsonSchemaFile) args.push("--json-schema", params.jsonSchemaFile);
  if (params.printTimeout) args.push("--print-timeout", params.printTimeout);

  // The prompt is user text and may legitimately begin with a slash. Without this,
  // agy reinterprets it as one of its own slash commands.
  args.push("--disable-slash-commands");

  return args;
}

/**
 * Put the prompt on the front of an argv, the way every measured invocation does.
 *
 * agy takes its prompt as the value of `-p`, so unlike the CLIs this design was
 * ported from there is no stdin path to put it on. Two consequences are stated
 * rather than hidden: the prompt is visible in `ps` to other processes of the same
 * OS user for the lifetime of the run, and it counts against the operating system's
 * argument-size limit, which `assertPromptFits` bounds.
 */
export function withPrompt(args: string[], prompt: string): string[] {
  return ["-p", prompt, ...args];
}

/**
 * The argv byte budget.
 *
 * macOS caps argv plus the environment at 1 MiB (`getconf ARG_MAX`); Linux's limit
 * is larger but not unbounded. Half of that is reserved here for the environment
 * and the remaining flags, which leaves a ceiling far above any real prompt while
 * still refusing before `spawn` fails with a bare E2BIG. The check is on UTF-8
 * bytes, not characters: a 250,000-character CJK prompt is about 750 kB.
 */
export const MAX_PROMPT_BYTES = 512 * 1024;

export function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

export type EffortSelection = {
  effort?: string;
  warnings: string[];
};

export function resolveEffortSelection(effort?: string): EffortSelection {
  if (!effort) return { warnings: [] };
  const normalized = String(effort).toLowerCase();
  if (EFFORT_LEVELS.has(normalized)) return { effort: normalized, warnings: [] };
  return {
    warnings: [
      `Ignoring effort "${effort}": agy accepts ${[...EFFORT_LEVELS].join(", ")}. Letting agy choose.`
    ]
  };
}

/* ------------------------------------------------------------------------- */
/* Stream parsing                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The terminal object every agy run produces.
 *
 * Under `--output-format json` it is the whole of stdout; under `stream-json` it
 * arrives as the payload of the final `result` event. The two are identical, which
 * is why one type covers both.
 */
export type AgyResultDocument = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: Record<string, number>;
  structured_output?: unknown;
  json_schema?: unknown;
};

export type AgyInitPayload = {
  model?: string;
  cwd?: string;
  tools?: unknown[];
  /**
   * Measured on 1.1.16 and absent from 1.1.15: `"request-review"` without
   * `--dangerously-skip-permissions`, `"always-proceed"` with it. It lets the
   * permission posture of a run be asserted from agy's own output rather than
   * inferred from the flags this plugin believes it passed.
   */
  permission_mode?: string;
};

export type AgyStreamEvent =
  | { event: "init"; conversation_id?: string; init?: AgyInitPayload }
  | { event: "step_update"; step_update?: AgyStepUpdate }
  | { event: "result"; result?: AgyResultDocument }
  | { event: string; [key: string]: unknown };

export type AgyToolInfo = {
  name?: string;
  /** Per-tool and PascalCase: view_file has AbsolutePath, run_command has CommandLine. */
  parameters?: Record<string, unknown>;
  /** A short summary of the result, present on the DONE emission only. */
  output?: string;
};

export type AgyStepUpdate = {
  conversation_id?: string;
  step_index?: number;
  /** Measured values: "ACTIVE" and "DONE". */
  state?: string;
  /** Measured values: "user_input", "checkpoint", "agent_response", "tool". */
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  duration_seconds?: number;
  usage?: Record<string, number>;
  [key: string]: unknown;
};

/**
 * The step type that means agy took an action.
 *
 * Measured: a tool call is emitted TWICE under the same `step_index` -- once with
 * `state: "ACTIVE"` carrying `tool_name` and `tool_info.parameters`, then once with
 * `state: "DONE"` carrying the same plus `tool_info.output`. Counting both would
 * double every tool call, and the tool-call count is what decides whether a review
 * is evidence or an opinion, so only the DONE emission is counted.
 */
export const TOOL_STEP_TYPE = "tool";
export const STEP_STATE_DONE = "DONE";

/**
 * Parameter keys that name something a tool inspected.
 *
 * agy's parameter objects are PascalCase and differ per tool -- `view_file` uses
 * `AbsolutePath`, `run_command` uses `CommandLine`, search tools use `Query` or
 * `SearchDirectory`. Only path-shaped keys are read, and only to count distinct
 * files a run actually opened. An unrecognised tool contributes to `toolCallCount`
 * but not to `filesInspected`, which is the safe direction: undercounting evidence
 * makes a review look thinner than it was, never richer.
 */
const INSPECTED_PATH_KEYS = ["AbsolutePath", "FilePath", "Path", "TargetFile", "NotebookPath"];

function inspectedPath(parameters: Record<string, unknown> | undefined): string | undefined {
  if (!parameters) return undefined;
  for (const key of INSPECTED_PATH_KEYS) {
    const value = parameters[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** One completed NDJSON line, reduced to what the streaming worker needs from it. */
export type StreamProgress = {
  /** Completed tool calls on this line: 0 or 1. */
  toolCalls: number;
  conversationId?: string;
  model?: string;
  permissionMode?: string;
  /** True once the terminal `result` event has been seen. */
  terminal?: boolean;
};

export function readStreamProgress(line: string): StreamProgress {
  if (!line.trim()) return { toolCalls: 0 };
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { toolCalls: 0 };
  }
  if (!event || typeof event !== "object") return { toolCalls: 0 };
  const typed = event as AgyStreamEvent & { status?: string; conversation_id?: string };

  // The plain `json` form: a bare result document with no event envelope. Handled
  // here too so a caller that switched formats is not silently uncounted.
  if (!typed.event && typeof typed.status === "string" && "conversation_id" in typed) {
    return { toolCalls: 0, conversationId: typed.conversation_id, terminal: true };
  }

  switch (typed.event) {
    case "init": {
      const init = (typed as { init?: AgyInitPayload }).init;
      return {
        toolCalls: 0,
        conversationId: typed.conversation_id,
        model: init?.model,
        permissionMode: init?.permission_mode
      };
    }
    case "step_update": {
      const step = (typed as { step_update?: AgyStepUpdate }).step_update ?? {};
      const completedToolCall = step.step_type === TOOL_STEP_TYPE && step.state === STEP_STATE_DONE;
      return { toolCalls: completedToolCall ? 1 : 0, conversationId: step.conversation_id };
    }
    case "result": {
      const result = (typed as { result?: AgyResultDocument }).result;
      return { toolCalls: 0, conversationId: result?.conversation_id, terminal: true };
    }
    default:
      return { toolCalls: 0 };
  }
}

export type ParsedAgyRun = {
  /** agy's own final answer. The result document wins; deltas are the fallback. */
  text: string;
  conversationId?: string;
  /** agy's own verdict: "SUCCESS" or "ERROR". */
  status?: string;
  errorText?: string;
  /** The model that actually ran, read off the `init` event. Never inferred. */
  observedModel?: string;
  /**
   * `init.cwd`, recorded but NOT trusted as proof of workspace targeting: measured,
   * it reports the spawning process's directory even on runs whose agent really
   * operated in ~/.gemini/antigravity-cli.
   */
  reportedCwd?: string;
  /**
   * agy's own permission posture for this run, from `init.permission_mode`.
   * "always-proceed" is what --dangerously-skip-permissions produces.
   */
  permissionMode?: string;
  /** Completed tool calls. The ACTIVE emission of each call is not counted. */
  toolCallCount: number;
  /** Distinct file paths a tool actually opened, from `tool_info.parameters`. */
  filesInspected: number;
  /** Tool names in call order, deduped and capped, as a cheap evidence trace. */
  toolNames: string[];
  /**
   * Model turns.
   *
   * Measured: agy's own `num_turns` is CUMULATIVE over the conversation, not per
   * invocation -- three calls on one conversation reported 1, then 2, then 3 -- so
   * on a resumed run this is a conversation depth, not the work this call did.
   */
  turnsUsed: number;
  eventCounts: Record<string, number>;
  lastEventType?: string;
  sawResultEvent: boolean;
  /** Present only when the run was given --json-schema; already validated by agy. */
  structuredOutput?: unknown;
  /**
   * The schema agy actually parsed, echoed back on the result.
   *
   * Worth reading: measured, a `--json-schema` argument that is neither valid JSON
   * nor a readable path is not rejected -- it is silently coerced into
   * `{"type":"string","description":"<the argument>"}`. Comparing this against what
   * was sent is the only way to notice.
   */
  jsonSchemaEcho?: unknown;
  usage?: Record<string, number>;
  durationSeconds?: number;
  numTurns?: number;
};

/** Cap on the tool-name trace, so a long run cannot bloat the summary. */
const MAX_TOOL_NAMES = 20;

/**
 * Parse a whole agy run from its stdout.
 *
 * Runs once, at the end of a job, when every NDJSON line is complete. The
 * incremental counterpart is `readStreamProgress`, which the worker calls per line.
 */
export function parseAgyRun(stdout: string): ParsedAgyRun | null {
  const raw = stdout.trim();
  if (!raw) return null;

  let result: AgyResultDocument | null = null;
  let observedModel: string | undefined;
  let reportedCwd: string | undefined;
  let permissionMode: string | undefined;
  let conversationId: string | undefined;
  let toolCallCount = 0;
  let turnsUsed = 0;
  let lastEventType: string | undefined;
  let sawResultEvent = false;
  const eventCounts: Record<string, number> = {};
  const inspectedPaths = new Set<string>();
  const toolNames: string[] = [];
  const textParts: string[] = [];
  let sawAnyEvent = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const typed = event as AgyStreamEvent & { status?: string; conversation_id?: string };

    // The plain `json` form: a bare result document with no event envelope.
    if (!typed.event && typeof typed.status === "string" && "conversation_id" in typed) {
      result = typed as AgyResultDocument;
      sawResultEvent = true;
      sawAnyEvent = true;
      lastEventType = "result";
      eventCounts.result = (eventCounts.result ?? 0) + 1;
      continue;
    }

    const name = typeof typed.event === "string" ? typed.event : "unknown";
    eventCounts[name] = (eventCounts[name] ?? 0) + 1;
    lastEventType = name;
    sawAnyEvent = true;

    switch (name) {
      case "init": {
        const init = (typed as { init?: AgyInitPayload }).init;
        observedModel ??= init?.model;
        reportedCwd ??= init?.cwd;
        permissionMode ??= init?.permission_mode;
        conversationId ??= typed.conversation_id;
        break;
      }
      case "step_update": {
        const step = (typed as { step_update?: AgyStepUpdate }).step_update ?? {};
        conversationId ??= step.conversation_id;
        if (step.step_type === "agent_response") {
          // text_delta is incremental, not cumulative: measured, an ACTIVE step
          // ended mid-word and its DONE step continued from the next character, and
          // concatenating every delta in order reproduces result.response exactly.
          if (typeof step.text_delta === "string") textParts.push(step.text_delta);
          if (step.state === STEP_STATE_DONE) turnsUsed += 1;
        } else if (step.step_type === TOOL_STEP_TYPE && step.state === STEP_STATE_DONE) {
          toolCallCount += 1;
          const name = step.tool_name ?? step.tool_info?.name;
          if (name && !toolNames.includes(name) && toolNames.length < MAX_TOOL_NAMES) {
            toolNames.push(name);
          }
          const path = inspectedPath(step.tool_info?.parameters);
          if (path) inspectedPaths.add(path);
        }
        break;
      }
      case "result": {
        result = (typed as { result?: AgyResultDocument }).result ?? null;
        sawResultEvent = true;
        conversationId ??= result?.conversation_id;
        break;
      }
      default:
        break;
    }
  }

  if (!sawAnyEvent) return null;

  // The result document is authoritative for the final text; the streamed deltas
  // are the fallback for a run killed before it emitted one.
  const text = String(result?.response ?? textParts.join("")).trim();

  return {
    text,
    conversationId: result?.conversation_id ?? conversationId,
    status: result?.status,
    errorText: result?.error,
    observedModel,
    reportedCwd,
    permissionMode,
    toolCallCount,
    filesInspected: inspectedPaths.size,
    toolNames,
    // num_turns is agy's own count and is preferred; the streamed tally is the
    // fallback for a run that never reached its result event.
    turnsUsed: typeof result?.num_turns === "number" ? result.num_turns : turnsUsed,
    eventCounts,
    lastEventType,
    sawResultEvent,
    structuredOutput: result?.structured_output,
    jsonSchemaEcho: result?.json_schema,
    usage: result?.usage,
    durationSeconds: result?.duration_seconds,
    numTurns: result?.num_turns
  };
}

/**
 * Did a resume land on the conversation it asked for?
 *
 * Measured, and the second of agy's two silent failures: an unknown
 * `--conversation <id>` does NOT fail. agy prints
 * `warning: conversation "<id>" not found` on stderr, exits 0, and starts a FRESH
 * conversation with a different id -- so a caller that resumed a lost handle gets a
 * confident answer from a model that has none of the context it thinks it has. The
 * only reliable detection is comparing the id that came back against the one that
 * was asked for.
 */
export const CONVERSATION_NOT_FOUND_PATTERN = /warning:\s*conversation\s+"([^"]*)"\s+not found/i;

export function detectConversationMismatch(params: {
  requestedConversationId?: string;
  observedConversationId?: string;
  stderr?: string;
}): string | null {
  if (!params.requestedConversationId) return null;
  const warned = params.stderr ? CONVERSATION_NOT_FOUND_PATTERN.test(params.stderr) : false;
  const drifted =
    Boolean(params.observedConversationId) &&
    params.observedConversationId !== params.requestedConversationId;
  if (!warned && !drifted) return null;
  return (
    `conversation_not_found: agy could not resume conversation ${params.requestedConversationId} and started a new ` +
    `one instead${params.observedConversationId ? ` (${params.observedConversationId})` : ""}. It exits 0 and reports ` +
    "SUCCESS when this happens, so the answer above was produced with NONE of the earlier context. Treat it as a " +
    "fresh run: re-send whatever context the task needs, and use agy_conversations to find a handle that still exists."
  );
}

/**
 * Parse `agy models`, which prints `id<TAB>Display Name` per line.
 *
 * The first line is a progress message (`Fetching available models...`) and is not
 * a model. Ids are the left column; the error text agy produces for an unknown
 * `--model` lists the RIGHT column, so a caller copying a name out of a failure
 * message would get a value `--model` does not accept.
 */
export function parseAgyModels(raw: string): { ids: string[]; lines: string[] } {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Fetching/i.test(line));
  const ids: string[] = [];
  for (const line of lines) {
    const id = line.split("\t")[0]?.trim();
    if (id && /^[a-z0-9][\w.-]*$/i.test(id) && !ids.includes(id)) ids.push(id);
  }
  return { ids, lines };
}

/* ------------------------------------------------------------------------- */
/* Permission and workspace evidence                                          */
/* ------------------------------------------------------------------------- */

/**
 * A headless agy run has no interactive approver, so every permission prompt
 * resolves to denied and the run ends `status: "ERROR"` having done nothing.
 *
 * Measured:
 *   permission check failed for command "cat a.txt": user denied permission to
 *   run command:\ncat a.txt
 *
 * The evidence is in the run document's `error` field on stdout, with stderr empty
 * -- the opposite of where the OpenCode plugin's equivalent guard looks -- so
 * callers pass the run's error text in alongside the stderr tail.
 */
const PERMISSION_DENIED_PATTERN =
  /permission check failed for (?:(?:command|tool call)\s+)?(?:["`']([^"`'\n]+)["`']|([\w-]+))\s*(?:\(([^)]*)\))?[^:\n]*:\s*user denied permission/gi;

/**
 * agy protects some of its own paths regardless of --dangerously-skip-permissions.
 * Measured: reading back a file it had just written under ~/.gemini/antigravity-cli
 * failed with this. It is agy's own rule, not something this plugin relies on.
 */
const PROTECTED_BOUNDARY_PATTERN =
  /Permission denied for (\w+)\(([^)]*)\)\.\s*Matches hardcoded system protection boundary rule/gi;

export type PermissionEvidence = {
  class: "permission_auto_denied" | "protected_path_blocked" | "workspace_not_targeted";
  target: string;
  message: string;
};

export function detectPermissionEvidence(
  stderrTail: string,
  options: { cwd?: string; errorText?: string } = {}
): PermissionEvidence[] {
  const evidence: PermissionEvidence[] = [];
  const seen = new Set<string>();
  const haystack = `${stderrTail ?? ""}\n${options.errorText ?? ""}`;

  for (const match of haystack.matchAll(PERMISSION_DENIED_PATTERN)) {
    // The quoted form carries the WHOLE command ("cat a.txt"), not just its first
    // word. A message naming `cat` when agy was denied `cat a.txt` sends the reader
    // looking for a permissions problem with a program rather than with a path.
    const target = (match[1] ?? match[2] ?? match[3] ?? "a tool call").trim();
    const key = `denied:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      class: "permission_auto_denied",
      target,
      message:
        `permission_auto_denied: agy asked for permission to run \`${target}\` and, having no interactive approver, ` +
        "denied itself. In the agy 1.1.18 E1 measurement, a denial terminated the run and cleared its answer. This " +
        "plugin always passes --dangerously-skip-permissions to avoid that gate, so seeing this means the run was " +
        "not started by this plugin."
    });
  }

  for (const match of haystack.matchAll(PROTECTED_BOUNDARY_PATTERN)) {
    const tool = match[1];
    const target = (match[2] ?? "").trim();
    const key = `boundary:${tool}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      class: "protected_path_blocked",
      target: target || tool,
      message:
        `protected_path_blocked: agy refused ${tool} on ${target} -- it sits behind agy's own hardcoded protection ` +
        "boundary, which --dangerously-skip-permissions does not lift. Anything that needed it was skipped."
    });
  }

  // Not a denial, but the same shape of silent uselessness: a run that was never
  // pointed at the workspace it was supposed to see.
  if (options.cwd && /does not exist in the (?:current working directory|workspace)/i.test(haystack)) {
    evidence.push({
      class: "workspace_not_targeted",
      target: options.cwd,
      message:
        `workspace_not_targeted: agy reported files missing from ${options.cwd}. agy does not inherit the process ` +
        "working directory -- without --add-dir it operates in ~/.gemini/antigravity-cli and sees none of the " +
        "repository. Check that the workspace this job recorded is the one you meant."
    });
  }

  return evidence;
}

/* ------------------------------------------------------------------------- */
/* Failure classification                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Error vocabulary.
 *
 * Codes shared with the sibling Codex plugins (`quota_exhausted`, `auth_required`,
 * `rate_limited`, `network_error`, `timeout`, `terminated`, `model_not_found`,
 * `model_unauthorized`) are reused verbatim so a single orchestrator driving
 * several of them learns one table, not several dialects.
 */
const NON_RETRYABLE_ERROR_CLASSES = new Set([
  "quota_exhausted",
  "auth_required",
  "model_unauthorized",
  "model_not_found",
  "permission_denied",
  "mirror_failed",
  "prompt_too_large",
  // Boundary codes a worker can file onto a record. BOUNDARY_RETRYABLE calls all
  // three non-retryable, and the same code must not read as retryable just because
  // it arrived as a job class instead of a refusal. `cli_probe_timeout` is
  // deliberately absent: it is the one boundary code that can succeed on a retry.
  "state_write_failed",
  "cli_not_found",
  "job_not_found",
  "file_attachment_invalid",
  "private_path_blocked",
  "workspace_out_of_bounds",
  "workspace_unavailable",
  "workspace_required"
]);

/** Retrying is the default; only classes that provably cannot succeed are excluded. */
export function isRetryableAgyFailure(errorClass: string | undefined): boolean {
  if (!errorClass) return false;
  return !NON_RETRYABLE_ERROR_CLASSES.has(errorClass);
}

/**
 * Ordered, because a provider often states two things on one line: the class that
 * decides what the caller should *do* wins. Billing before throughput (waiting does
 * not refill a balance), and every HTTP code travels with context -- a bare 403 is
 * also what git says about a private remote.
 */
const FAILURE_CLASS_PATTERNS: Array<[string, RegExp]> = [
  // agy's own --print-timeout. Measured: exit 1, empty stderr, and a complete
  // result document carrying exactly this string, duration_seconds 0 and zeroed
  // usage. It is the same outcome as the worker's wall-clock budget, so it gets the
  // same class -- and a conversation id is still allocated, so it is still resumable.
  ["timeout", /timeout waiting for response/i],
  [
    "model_unauthorized",
    /\b403\b[^\n]{0,160}\bmodels?\b|\bmodels?\b[^\n]{0,160}\b403\b|not authori[sz]ed to access the requested model|unauthori[sz]ed to (?:use|access) (?:the )?model|(?:does not|doesn't|do not) have access to (?:the )?model/i
  ],
  [
    "quota_exhausted",
    /\b402\b|insufficient (?:credit|balance|funds|quota)|credit balance is too low|quota (?:exceeded|exhausted)|exceeded your (?:current |monthly |daily )?quota|out of credits|billing hard limit/i
  ],
  [
    "auth_required",
    /\b401\b|no credentials|not authenticated|unauthenticated|authentication required|auth login|sign in to continue/i
  ],
  ["rate_limited", /\b429\b|rate[ _-]?limit|too many requests|overloaded|slow down/i],
  // agy's own hint names an id. A bare "did you mean" is ordinary English -- a model
  // asking "Did you mean to run the tests first?" is not a missing-model error.
  [
    "model_not_found",
    /model not found|unknown model|no such model id|is not recognized as a known model|invalid model selection|did you mean:?\s*["'`]?[\w.-]+(?:\/[\w.:-]+)?\s*$/im
  ],
  ["permission_denied", /permission check failed[^\n]*user denied permission/i],
  ["network_error", /econnrefused|enotfound|eai_again|econnreset|etimedout|socket hang up|network error|tunnel/i],
  ["provider_error", /unexpected server error|internal server error|\b5\d\d\s+(?:error|status)/i]
];

/**
 * Classify why a run failed, from the evidence a headless run leaves behind.
 *
 * Only real error channels are read: the process outcome, and the run document's
 * own `error` string, and stderr. agy's answer text is never part of the haystack
 * -- a review that mentions a 403 is not a 403. Measured and load-bearing: an
 * unrecognised `--model` exits 1 with an EMPTY stderr and the whole explanation
 * inside the result document's `error` field, so a classifier that reads stderr
 * alone files every real agy failure as "no recognised reason".
 */
export function classifyAgyErrorText(value: string): string | undefined {
  if (!value.trim()) return undefined;
  for (const [errorClass, pattern] of FAILURE_CLASS_PATTERNS) {
    if (pattern.test(value)) return errorClass;
  }
  return undefined;
}

export function classifyAgyFailure(params: {
  timedOut?: boolean;
  signal?: NodeJS.Signals | null;
  exitCode?: number | null;
  stderr?: string;
  /** The run document's own `error` field, which is where agy puts the reason. */
  errorText?: string;
}): string {
  if (params.timedOut) return "timeout";
  // A non-null signal means something outside agy ended it. That is never a
  // statement about the model or the account.
  if (params.signal) return "terminated";
  const haystack = `${params.errorText ?? ""}\n${params.stderr ?? ""}`;
  const classified = classifyAgyErrorText(haystack);
  if (classified) return classified;
  if (params.errorText?.trim()) return "agy_failed";
  if (params.exitCode !== 0) return "agy_failed";
  return "unknown";
}

/** One sentence per class, telling the caller what to do instead of retrying blindly. */
export function agyFailureMessage(errorClass: string): string {
  switch (errorClass) {
    case "quota_exhausted":
      return "The Antigravity account's balance or usage quota is exhausted. Retrying will fail; top it up or switch to another account.";
    case "auth_required":
      return "agy is not signed in. Run `agy` once in a terminal and complete the Google sign-in, then re-run agy_check to confirm.";
    case "model_unauthorized":
      return "This Antigravity account is not authorized for the requested model. Choose one `agy models` lists, or omit model and let agy pick. Retrying the same model will fail the same way.";
    case "model_not_found":
      return "agy does not recognise that model id. agy_check lists the ids it accepts (for example gemini-3.7-flash-low, claude-sonnet-4-6).";
    case "rate_limited":
      return "The provider is rate-limiting or overloaded. This one is transient: wait and re-run the same request unchanged.";
    case "network_error":
      return "agy could not reach its provider. Check network, proxy, and certificate configuration before retrying.";
    case "provider_error":
      return "The provider returned a server-side error, which is worth retrying once. If it repeats, switch model rather than rewording the prompt.";
    case "permission_denied":
      return "agy denied a tool call. In the agy 1.1.18 E1 measurement, a denial terminated the run and cleared its answer. This plugin always passes --dangerously-skip-permissions to avoid that gate, so a run that reports this was not started by this plugin.";
    case "terminated":
      return "agy was terminated by a signal before producing a final result.";
    case "timeout":
      return "agy exceeded its wall-clock budget.";
    case "stalled":
      return "agy produced no output at all for the stall window, which is a provider or model hang rather than slow work. Retry with a lighter explicit model, or check the provider and proxy configuration.";
    case "agy_canceled":
      return "agy 1.1.18 reported terminal status CANCELED, and the run produced no usable result. Because the same prompt was observed reaching SUCCESS, ERROR, and CANCELED on agy 1.1.18, the outcome is nondeterministic across runs, so a retry is reasonable before changing the request.";
    case "agy_failed":
      return "agy exited without a usable final result. The run document's `error` field is the evidence; if it is empty too, re-run with a narrower task.";
    default:
      return "agy exited without a usable final result.";
  }
}

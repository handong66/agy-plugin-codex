import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  agyFailureMessage,
  buildAgyArgs,
  classifyAgyFailure,
  discoverAgy,
  discoveryFailure,
  isRetryableAgyFailure,
  MAX_PROMPT_BYTES,
  parseAgyRun,
  promptByteLength,
  resolveEffortSelection,
  runAgy,
  withPrompt
} from "./agy-cli.js";
import { knownModelIds, listModels } from "./check-cache.js";
import { listConversations } from "./conversation-registry.js";
import {
  JobStore,
  summarizeAgyOutput,
  toPublicJob,
  WORKSPACE_PLACEHOLDER,
  type JobKind,
  type JobRecord,
  type JobResultView,
  type WorkspaceMode
} from "./job-store.js";
import { printTimeoutFor, resolveTimeoutBudget } from "./timeout-budget.js";
import {
  BoundaryError,
  isBoundaryError,
  mirrorFailed,
  promptTooLarge,
  workspaceOutOfBounds,
  workspaceUnavailable
} from "./boundary.js";
import {
  compareFingerprints,
  createReadOnlyMirror,
  diffMirrorSnapshots,
  fingerprintTree,
  listMirrorFiles,
  rewriteMirrorPaths,
  snapshotMirror,
  type IsolationWarning
} from "./readonly-mirror.js";

export type CommonArgs = {
  cwd?: string;
  model?: string;
  effort?: string;
  /** Trusted roots injected by the MCP server from per-call client metadata. */
  _workspaceRoots?: string[];
  /** Path-free description of how the per-call metadata was decoded. */
  _workspaceRequestMeta?: WorkspaceRequestMetaDiagnostics;
  /** Path-free diagnostics for trusted roots recovered outside the two MCP sources. */
  _workspaceAdditionalSources?: WorkspaceAdditionalSourcesDiagnostics;
};

export type WorkspaceRootsListDiagnostics = {
  supported: boolean;
  ok: boolean;
  count: number;
  errorCode?: string;
};

export type WorkspaceRequestMetaDiagnostics = {
  metaPresent: boolean;
  turnMetadataPresent: boolean;
  turnMetadataType: string;
  parseSucceeded: boolean;
  workspaceCount: number;
};

export type WorkspaceSessionMetaDiagnostics = {
  threadIdPresent: boolean;
  rolloutFound: boolean;
  cwdPresent: boolean;
  count: number;
};

export type WorkspaceConfiguredRootsDiagnostics = {
  configured: boolean;
  ok: boolean;
  count: number;
  errorCode?: string;
};

export type WorkspaceCallerCwdDiagnostics = {
  provided: boolean;
  ok: boolean;
  count: number;
  errorCode?: string;
};

export type WorkspaceAdditionalSourcesDiagnostics = {
  sessionMeta?: WorkspaceSessionMetaDiagnostics;
  configuredRoots?: WorkspaceConfiguredRootsDiagnostics;
  callerCwd?: WorkspaceCallerCwdDiagnostics;
};

export type WorkspaceSourcesDiagnostics = {
  rootsList: WorkspaceRootsListDiagnostics;
  requestMeta: WorkspaceRequestMetaDiagnostics;
} & WorkspaceAdditionalSourcesDiagnostics;

export type WorkspaceRootsProviderResult = {
  roots: string[];
  diagnostics: WorkspaceRootsListDiagnostics;
};

type WorkspaceRootsProvider = () => Promise<string[] | WorkspaceRootsProviderResult>;

const MISSING_REQUEST_META: WorkspaceRequestMetaDiagnostics = {
  metaPresent: false,
  turnMetadataPresent: false,
  turnMetadataType: "missing",
  parseSucceeded: false,
  workspaceCount: 0
};

let workspaceRootsProvider: WorkspaceRootsProvider = async () => [process.cwd()];

export function configureWorkspaceRootsProvider(provider: WorkspaceRootsProvider): void {
  workspaceRootsProvider = provider;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function normalizeWorkspaceRootsProviderResult(
  result: string[] | WorkspaceRootsProviderResult
): WorkspaceRootsProviderResult {
  if (!Array.isArray(result)) return result;
  return { roots: result, diagnostics: { supported: true, ok: true, count: result.length } };
}

async function resolvedWorkspaceRootsContext(
  requestWorkspaceRoots: string[] = [],
  requestMeta: WorkspaceRequestMetaDiagnostics = MISSING_REQUEST_META,
  additionalSources: WorkspaceAdditionalSourcesDiagnostics = {}
): Promise<{ roots: string[]; sources: WorkspaceSourcesDiagnostics }> {
  const standard = await workspaceRootsProvider()
    .then(normalizeWorkspaceRootsProviderResult)
    .catch(() => ({
      roots: [] as string[],
      diagnostics: { supported: true, ok: false, count: 0, errorCode: "provider_failed" }
    }));
  const sources = { rootsList: standard.diagnostics, requestMeta, ...additionalSources };
  const providedRoots = [...new Set([...standard.roots, ...requestWorkspaceRoots])];
  const workspaceRoots = await Promise.all(
    providedRoots.map(async (root) => {
      const resolvedRoot = await realpath(root).catch(() => {
        throw workspaceUnavailable(`MCP workspace root could not be resolved: ${root}.`, {
          root,
          workspaceSources: sources
        });
      });
      if (!(await stat(resolvedRoot)).isDirectory()) {
        throw workspaceUnavailable(`MCP workspace root is not a directory: ${resolvedRoot}.`, {
          root: resolvedRoot,
          workspaceSources: sources
        });
      }
      return resolvedRoot;
    })
  );
  if (!workspaceRoots.length) {
    // For agy this is fatal rather than degraded: it has no process-cwd fallback,
    // and a run with no --add-dir operates inside ~/.gemini/antigravity-cli.
    throw workspaceUnavailable(
      "No trusted filesystem workspace root is available, and agy cannot run without one: it ignores the process " +
        "working directory entirely, so a run with no --add-dir operates inside ~/.gemini/antigravity-cli and sees " +
        "none of the repository. Provide an explicit absolute cwd, standard roots/list, per-call Codex workspace " +
        "metadata, a persisted current-thread cwd, or AGY_WORKSPACE_ROOTS. agy_check reports which source was absent " +
        "or unusable; it still returns CLI and model diagnostics in this state, while execution tools do not run.",
      { workspaceSources: sources }
    );
  }
  return { roots: workspaceRoots, sources };
}

async function resolvedWorkspaceRoots(
  requestWorkspaceRoots: string[] = [],
  requestMeta: WorkspaceRequestMetaDiagnostics = MISSING_REQUEST_META,
  additionalSources: WorkspaceAdditionalSourcesDiagnostics = {}
): Promise<string[]> {
  return (await resolvedWorkspaceRootsContext(requestWorkspaceRoots, requestMeta, additionalSources)).roots;
}

/**
 * Resolve and VALIDATE the directory agy will be pointed at.
 *
 * The realpath and isDirectory checks here are not defensive tidiness. Measured:
 * agy does not reject an `--add-dir` that does not exist -- it exits 0, reports
 * SUCCESS, writes nothing to stderr, and silently runs inside its own state
 * directory. Nothing in the run's output distinguishes that from a real run, so
 * this is the only place the mistake can be caught.
 */
async function cwdWithinWorkspace(cwd: string | undefined, workspaceRoots: string[]): Promise<string> {
  let candidate: string;
  try {
    candidate = await realpath(resolve(cwd ?? workspaceRoots[0]));
  } catch {
    throw new BoundaryError(
      "workspace_out_of_bounds",
      `Working directory does not exist: ${cwd ?? workspaceRoots[0]}. Available roots: ${workspaceRoots.join(", ")}. ` +
        "agy silently ignores an unusable --add-dir and runs in its own state directory instead, so this is refused " +
        "rather than passed through.",
      { candidate: cwd ?? workspaceRoots[0], roots: workspaceRoots }
    );
  }
  if (!workspaceRoots.some((root) => isWithin(root, candidate))) {
    throw workspaceOutOfBounds(candidate, workspaceRoots);
  }
  if (!(await stat(candidate)).isDirectory()) {
    throw new BoundaryError(
      "workspace_out_of_bounds",
      `Working directory is not a directory: ${candidate}. Available roots: ${workspaceRoots.join(", ")}.`,
      { candidate, roots: workspaceRoots }
    );
  }
  return candidate;
}

async function cwdOrDefault(
  cwd?: string,
  requestWorkspaceRoots: string[] = [],
  requestMeta: WorkspaceRequestMetaDiagnostics = MISSING_REQUEST_META,
  additionalSources: WorkspaceAdditionalSourcesDiagnostics = {}
): Promise<string> {
  const context = await resolvedWorkspaceRootsContext(
    requestWorkspaceRoots,
    requestMeta,
    additionalSources
  );
  return cwdWithinWorkspace(cwd, context.roots);
}

/** Above this, the payload is returned once (as structuredContent) instead of twice. */
const MAX_TEXT_PAYLOAD_CHARS = 8_192;

/**
 * Every response used to go out twice: pretty-printed as `content[0].text` and
 * again as `structuredContent`. Small payloads still carry both, because callers
 * read the text; large ones do not.
 */
function jsonText(value: unknown) {
  const structuredContent = value as Record<string, unknown>;
  const serialized = JSON.stringify(value);
  const text =
    serialized.length <= MAX_TEXT_PAYLOAD_CHARS
      ? serialized
      : JSON.stringify({
          ok: structuredContent?.ok,
          structuredContentOnly: true,
          payloadChars: serialized.length,
          note:
            `Payload is ${serialized.length} characters and was returned once, as MCP structuredContent. ` +
            "Read it there; it is deliberately not duplicated as text."
        });
  return { content: [{ type: "text" as const, text }], structuredContent };
}

export type ToolError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

/**
 * Legacy top-level fields kept alongside `data`.
 *
 * Only cheap scalars are mirrored. The bulk fields (`job`, `record`, `stdout`,
 * `stderr`, `outputSummary`, `modelsRaw`, ...) live in `data` and nowhere else.
 */
const LEGACY_TOP_LEVEL_MIRRORS = new Set([
  "background",
  "terminal",
  "nextAction",
  "waited",
  "resumable",
  "agyConversationId",
  "observedModel",
  "errorClass",
  "exitCode",
  "bin",
  "version",
  "agyBin",
  "workspaceMode",
  "readOnly",
  "stdoutTruncated",
  "stderrTruncated",
  "maxChars",
  "maxCharsClamped",
  "view",
  "rawOmitted"
]);

/**
 * The one response shape: `ok` is the outcome, `error` is typed and says whether a
 * retry can work, `warnings` is always an array, and `data` is the payload.
 */
function envelope(params: {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: ToolError;
  warnings?: string[];
}) {
  const mirrors: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.data ?? {})) {
    if (LEGACY_TOP_LEVEL_MIRRORS.has(key) && value !== undefined) mirrors[key] = value;
  }
  return jsonText({
    ok: params.ok,
    ...(params.error ? { error: params.error } : {}),
    warnings: params.warnings ?? [],
    ...mirrors,
    ...(params.data ? { data: params.data } : {})
  });
}

/** Turn a typed boundary refusal into the same envelope every other failure uses. */
function boundaryEnvelope(error: BoundaryError) {
  return envelope({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {})
    },
    warnings: []
  });
}

/**
 * Boundary refusals are returned, not thrown. An MCP exception carries no code, no
 * `retryable`, and no structure a caller can branch on.
 */
async function guarded<T extends { structuredContent: Record<string, unknown> }>(
  run: () => Promise<T>
): Promise<T | ReturnType<typeof boundaryEnvelope>> {
  try {
    return await run();
  } catch (error) {
    if (isBoundaryError(error)) return boundaryEnvelope(error);
    throw error;
  }
}

/* ------------------------------------------------------------------------- */
/* Prompt boundaries                                                          */
/* ------------------------------------------------------------------------- */

const CODEX_PRIVATE_PATH_PATTERN = /(?:^|[\s"'`(])(?:~|\$HOME|\/[^\s"'`)]+)\/\.codex(?:\/|\b)/g;

/** How much text around a hit is enough to find it in a very long prompt. */
const PRIVATE_PATH_CONTEXT_CHARS = 40;
const MAX_PRIVATE_PATH_HITS = 3;

/**
 * Show where the guard fired. The home directory is masked so the preview does not
 * echo an absolute user path back into the transcript.
 */
function privatePathHits(prompt: string): { preview: string; index: number }[] {
  const home = homedir();
  const hits: { preview: string; index: number }[] = [];
  for (const match of prompt.matchAll(CODEX_PRIVATE_PATH_PATTERN)) {
    if (hits.length >= MAX_PRIVATE_PATH_HITS) break;
    const index = match.index ?? 0;
    const start = Math.max(0, index - PRIVATE_PATH_CONTEXT_CHARS);
    const end = Math.min(prompt.length, index + match[0].length + PRIVATE_PATH_CONTEXT_CHARS);
    const window = prompt.slice(start, end).replace(/\s+/g, " ").trim();
    hits.push({
      preview: `${start > 0 ? "..." : ""}${window.split(home).join("~")}${end < prompt.length ? "..." : ""}`,
      index
    });
  }
  return hits;
}

function validatePromptBoundary(prompt: string, allowCodexPrivatePaths?: boolean): void {
  const bytes = promptByteLength(prompt);
  if (bytes > MAX_PROMPT_BYTES) throw promptTooLarge(bytes, MAX_PROMPT_BYTES);

  if (allowCodexPrivatePaths) return;
  const hits = privatePathHits(prompt);
  if (hits.length) {
    throw new BoundaryError(
      "private_path_blocked",
      "Prompt asks agy to read Codex private runtime paths such as ~/.codex. " +
        `First match at character ${hits[0].index}: ${JSON.stringify(hits[0].preview)}. ` +
        "Inline the collaboration instructions in prompt instead. agy is only told about the workspace passed to " +
        "--add-dir, but it runs with permissions skipped and is not sandboxed to it, so this guard is the boundary, " +
        "not a backstop. Set allowCodexPrivatePaths only when the user explicitly authorizes that private path " +
        "access.",
      { hits, promptChars: prompt.length }
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Prompt templates                                                           */
/* ------------------------------------------------------------------------- */

const HEADLESS_DELEGATION_PREAMBLE =
  "This is a headless, single-purpose delegation. Ignore repository bootstrap instructions that tell you to load " +
  "interactive skills or personas. Do not narrate steps. Your only text output is the final answer.";

/**
 * A hard file budget for bounded reviews. An unbounded review walks the tree until
 * the wall-clock budget ends it, and then there is no answer at all.
 */
const REVIEW_FILE_BUDGET_RULE =
  "Do not open more than 20 files. If the target genuinely spans more, review the most relevant subset within that " +
  "budget and state exactly which files you reviewed and which you skipped.";

/**
 * What a reviewer is told about the copy it is working in.
 *
 * It is working in a disposable copy of the tree, built from git's file list, so
 * ignored paths are absent and any edit it makes is discarded. Saying so prevents
 * the two failure modes this design otherwise creates: a reviewer that reports a
 * missing `node_modules` as a finding, and a reviewer that "fixes" something and
 * reports it as fixed.
 */
const MIRROR_DISCLOSURE =
  "You are working in a disposable copy of the repository's working tree, built from git's tracked and untracked " +
  "file list. Files git ignores (build output, dependencies such as node_modules, local environment files) are NOT " +
  "present -- their absence is not a finding, and unresolved imports into them are not findings. Any edit you make " +
  "here is discarded and will not reach the user's repository, so do not edit anything and do not report anything " +
  "as fixed. Report only what you read.";

function threatModelRules(threatModel?: string): string[] {
  if (threatModel) {
    return [
      `Operating context for this review: ${threatModel}`,
      "Label every finding in-model or out-of-model against that context. An out-of-model finding is advisory only: " +
        "it must never be a blocker, a NO_GO, or a reason to stop work in progress. Say so explicitly on each one."
    ];
  }
  return [
    "No operating context was supplied. Judge the named target on its own terms as a robustness review, do not " +
      "escalate it into a security audit, and mark anything that depends on an operating context you were not given " +
      "as advisory rather than blocking."
  ];
}

/* ------------------------------------------------------------------------- */
/* Foreground bounds                                                          */
/* ------------------------------------------------------------------------- */

const FOREGROUND_MAX_OUTPUT_CHARS = 100_000;
const FOREGROUND_TAIL_CHARS = 20_000;

/**
 * Fail a model id that `agy_check` has already enumerated as unknown.
 *
 * Nothing is spawned for this: it uses the listing that is already cached, and says
 * nothing at all when there is none. Only a listing that actually produced ids is
 * treated as the authority -- an unsure parse must not refuse the caller's work.
 */
function assertKnownModel(model: string): void {
  const known = knownModelIds();
  if (!known.length || known.includes(model)) return;
  throw new BoundaryError(
    "model_not_found",
    `agy does not list "${model}" as a model this account can reach. Known ids: ${known.join(", ")}. ` +
      "Note that agy's own error message for a bad model prints DISPLAY names (\"Gemini 3.7 Flash (Low)\"), " +
      "while --model takes the id (\"gemini-3.7-flash-low\"). Omit model to let agy choose.",
    { requested: model, known }
  );
}

/* ------------------------------------------------------------------------- */
/* Run submission                                                             */
/* ------------------------------------------------------------------------- */

type RunParams = {
  kind: JobKind;
  prompt: string;
  cwd?: string;
  _workspaceRoots?: string[];
  _workspaceRequestMeta?: WorkspaceRequestMetaDiagnostics;
  _workspaceAdditionalSources?: WorkspaceAdditionalSourcesDiagnostics;
  model?: string;
  effort?: string;
  conversationId?: string;
  /** Read-only: agy is handed a disposable copy instead of the repository. */
  readOnly?: boolean;
  background?: boolean;
  timeoutMs?: number;
  allowCodexPrivatePaths?: boolean;
  trustedAgyBin?: string;
};

async function runOrStartJob(params: RunParams) {
  const cwd = await cwdOrDefault(
    params.cwd,
    params._workspaceRoots,
    params._workspaceRequestMeta,
    params._workspaceAdditionalSources
  );
  validatePromptBoundary(params.prompt, params.allowCodexPrivatePaths);

  const background = params.background ?? true;
  const budget = resolveTimeoutBudget({
    kind: params.kind,
    background,
    requestedTimeoutMs: params.timeoutMs
  });
  const effort = resolveEffortSelection(params.effort);
  if (params.model) assertKnownModel(params.model);
  const warnings = [...budget.warnings, ...effort.warnings];
  const workspaceMode: WorkspaceMode = params.readOnly ? "mirror" : "direct";

  if (params.readOnly) {
    // Cheap pre-check so the refusal is synchronous and typed. Without it a
    // background review outside a git repository returns ok:true with a jobId and
    // only fails inside the worker, where the caller sees it far later and cannot
    // tell a missing repository from a crash.
    if ((await listMirrorFiles(cwd)) === null) {
      throw mirrorFailed(
        `${cwd} is not a git repository (or git is unavailable), and the copy is built from git's own file list`,
        { repoRoot: cwd }
      );
    }
  }

  if (params.readOnly) {
    warnings.push(
      "Read-only here is a filesystem guarantee, not a prompt: agy is given a disposable copy of the working tree " +
        "and is never told this repository's path. In the agy 1.1.18 E1 measurement, a denied tool call terminated " +
        "the run and cleared its answer, so the copy is run with permissions skipped to avoid that gate. It protects " +
        "the repository, not the whole filesystem -- the agy 1.1.16 probes observed writes to " +
        "~/.gemini/antigravity-cli. Files git ignores are not in the copy."
    );
  }

  const flags = buildAgyArgs({
    // Always the placeholder, on both paths. A disposable copy does not exist until
    // something builds it -- the worker for a background job, `runForeground` for a
    // synchronous one -- and letting the foreground path bake `cwd` in here is
    // exactly how a read-only review ends up pointed at the real repository.
    workspace: WORKSPACE_PLACEHOLDER,
    model: params.model,
    effort: effort.effort,
    resumeConversationId: params.conversationId,
    readOnly: params.readOnly,
    // agy's own deadline, set inside the worker's budget so it gets the chance to
    // write a result document -- with its conversation id -- before it is signalled.
    printTimeout: printTimeoutFor(budget.timeoutMs)
  });

  if (background) {
    const store = new JobStore();
    const job = await store.startAgyJob({
      kind: params.kind,
      cwd,
      args: flags,
      prompt: params.prompt,
      workspaceMode,
      timeoutMs: budget.timeoutMs,
      agyBin: params.trustedAgyBin,
      requestedConversationId: params.conversationId,
      requestedModel: params.model,
      requestedEffort: effort.effort
    });
    return envelope({
      ok: true,
      data: {
        background: true,
        readOnly: params.readOnly === true,
        workspaceMode,
        job: toPublicJob(job)
      },
      warnings
    });
  }

  return await runForeground({ ...params, cwd, flags, budgetMs: budget.timeoutMs, warnings, workspaceMode });
}

/**
 * A synchronous run. The mirror lifecycle is owned here rather than by the worker,
 * because there is no worker.
 */
async function runForeground(params: RunParams & {
  cwd: string;
  flags: string[];
  budgetMs: number;
  warnings: string[];
  workspaceMode: WorkspaceMode;
}) {
  const warnings = [...params.warnings];
  const isolationWarnings: IsolationWarning[] = [];
  const mirror = params.readOnly ? await createReadOnlyMirror(params.cwd) : undefined;
  const workspace = mirror?.path ?? params.cwd;
  const fingerprintBefore = mirror ? await fingerprintTree(params.cwd) : null;
  const mirrorBefore = mirror ? await snapshotMirror(mirror.path) : null;

  try {
    // Substitute the workspace the same way the background worker does. This is the
    // only place a foreground run's `--add-dir` is decided, so a review reaches agy
    // with the disposable copy's path and never the repository's.
    const flags = params.flags.map((flag) => (flag === WORKSPACE_PLACEHOLDER ? workspace : flag));
    if (flags.includes(WORKSPACE_PLACEHOLDER)) {
      throw new Error("Workspace placeholder survived substitution; refusing to run agy.");
    }
    const result = await runAgy(withPrompt(flags, params.prompt), {
      cwd: params.cwd,
      agyBin: params.trustedAgyBin,
      timeoutMs: params.budgetMs,
      maxOutputChars: FOREGROUND_MAX_OUTPUT_CHARS
    });

    if (mirror) {
      const wrote = diffMirrorSnapshots(mirrorBefore, await snapshotMirror(mirror.path));
      if (wrote) isolationWarnings.push(wrote);
      const changed = compareFingerprints(fingerprintBefore, await fingerprintTree(params.cwd));
      if (changed) isolationWarnings.push(changed);
    }

    const stdout = mirror ? await rewriteMirrorPaths(result.stdout, mirror.path, params.cwd) : result.stdout;
    const stderr = mirror ? await rewriteMirrorPaths(result.stderr, mirror.path, params.cwd) : result.stderr;
    const parsed = parseAgyRun(stdout);

    // agy's own verdict outranks the exit code, and a spent budget or an externally
    // delivered signal outranks both.
    const runErrored = parsed?.status === "ERROR" || Boolean(parsed?.errorText);
    const processSucceeded =
      result.exitCode === 0 && !result.timedOut && !result.signal && !runErrored;
    const completedAt = new Date().toISOString();
    const summaryRecord: JobRecord = {
      id: "job_foreground_summary",
      kind: params.kind,
      status: processSucceeded ? "succeeded" : "failed",
      cwd: params.cwd,
      command: result.bin,
      args: flags,
      workspaceMode: params.workspaceMode,
      agyConversationId: parsed?.conversationId,
      requestedConversationId: params.conversationId,
      observedModel: parsed?.observedModel,
      requestedModel: params.model,
      createdAt: completedAt,
      startedAt: completedAt,
      finishedAt: completedAt,
      timeoutMs: params.budgetMs,
      exitCode: result.exitCode,
      signal: result.signal,
      errorClass: processSucceeded
        ? undefined
        : classifyAgyFailure({
            timedOut: result.timedOut,
            signal: result.signal,
            exitCode: result.exitCode,
            stderr,
            errorText: parsed?.errorText
          }),
      ...(isolationWarnings.length ? { isolation: { warnings: isolationWarnings } } : {}),
      stdoutPath: "",
      stderrPath: ""
    };

    // The complete buffers still feed the classifier and the summary; only what
    // crosses the wire is bounded.
    const stdoutTail = stdout.slice(-FOREGROUND_TAIL_CHARS);
    const stderrTail = stderr.slice(-FOREGROUND_TAIL_CHARS);
    const failureClass = processSucceeded ? undefined : (summaryRecord.errorClass ?? "unknown");
    const outputSummary = summarizeAgyOutput(summaryRecord, stdout, stderr);
    return envelope({
      ok: processSucceeded,
      ...(failureClass
        ? {
            error: {
              code: failureClass,
              message: parsed?.errorText ?? agyFailureMessage(failureClass),
              retryable: isRetryableAgyFailure(failureClass)
            }
          }
        : {}),
      data: {
        background: false,
        readOnly: params.readOnly === true,
        workspaceMode: params.workspaceMode,
        bin: result.bin,
        exitCode: result.exitCode,
        stdout: stdoutTail,
        stderr: stderrTail,
        stdoutTruncated: result.stdoutTruncated === true || stdoutTail.length < stdout.length,
        stderrTruncated: result.stderrTruncated === true || stderrTail.length < stderr.length,
        errorClass: summaryRecord.errorClass,
        agyConversationId: parsed?.conversationId,
        observedModel: parsed?.observedModel,
        resumable: Boolean(parsed?.conversationId),
        outputSummary
      },
      warnings: [...warnings, ...outputSummary.warnings]
    });
  } finally {
    await mirror?.cleanup();
  }
}

/* ------------------------------------------------------------------------- */
/* Tools                                                                      */
/* ------------------------------------------------------------------------- */

export async function agyCheck(args: CommonArgs & { includeModels?: boolean; force?: boolean }) {
  return guarded(() => agyCheckImpl(args));
}

/**
 * Hide the userinfo in a proxy URL. `HTTPS_PROXY=http://user:password@proxy:3128`
 * is the ordinary corporate form, and this answer is persisted in the transcript.
 */
export function maskProxyCredentials(value: string): string {
  return value.replace(/(^|:\/\/)[^/@\s]+@/g, (_match, prefix: string) => `${prefix}***@`);
}

async function agyCheckImpl(args: CommonArgs & { includeModels?: boolean; force?: boolean }) {
  const discovered = await discoverAgy({ force: args.force });
  const warnings: string[] = [];
  const data: Record<string, unknown> = {
    agyBin: discovered.bin,
    version: discovered.version,
    tried: discovered.tried,
    errors: discovered.errors
  };

  if (!discovered.ok) {
    const failure = discoveryFailure(discovered);
    return envelope({
      ok: false,
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
      data,
      warnings
    });
  }

  // A missing workspace root must not hide CLI and model information that has
  // nothing to do with the workspace -- that is exactly when a caller needs it.
  // Diagnostics degrade; execution tools stay fail-closed and still refuse.
  let cwd: string | undefined;
  try {
    const context = await resolvedWorkspaceRootsContext(
      args._workspaceRoots,
      args._workspaceRequestMeta,
      args._workspaceAdditionalSources
    );
    data.workspaceSources = context.sources;
    cwd = await cwdWithinWorkspace(args.cwd, context.roots);
    data.workspace = { ok: true, cwd };
  } catch (error) {
    const boundary = isBoundaryError(error) ? error : undefined;
    const workspaceSources = boundary?.details?.workspaceSources;
    if (workspaceSources) data.workspaceSources = workspaceSources;
    data.workspace = {
      ok: false,
      error: {
        code: boundary?.code ?? "workspace_unavailable",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        retryable: boundary?.retryable ?? false
      }
    };
    warnings.push(
      "Workspace validation failed, so every execution tool will refuse until a workspace root is available. " +
        "Do not fall back to a raw agy CLI call -- that bypasses the workspace, permission, path and job-record " +
        "contracts, and a raw call without --add-dir runs inside agy's own state directory."
    );
  }

  // Environment facts agy itself will obey. A global proxy is a day-0 failure
  // surface, and nothing else in this diagnostic would mention it.
  const proxy = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].flatMap((name) => {
      const value = process.env[name] ?? process.env[name.toLowerCase()];
      return value ? [[name, maskProxyCredentials(value)]] : [];
    })
  );
  data.proxy = proxy;
  if (Object.keys(proxy).length) {
    warnings.push(
      `A proxy is configured for this MCP server process (${Object.keys(proxy).join(", ")}). ` +
        "agy inherits it; if runs fail or hang, test with the proxy disabled before blaming the model."
    );
  }

  // agy has no `auth list` and no per-provider credential store: it signs in with a
  // Google account and keeps the token in the OS keyring. The model listing is the
  // cheapest observable proof that the sign-in works, because it is a real backend
  // call. Anything stronger would cost a model turn.
  if (args.includeModels !== false) {
    const models = await listModels({
      agyBin: discovered.bin,
      cwd: cwd ?? tmpdir(),
      force: args.force
    }).catch((error) => {
      warnings.push(`agy models failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (models) {
      data.models = models.ids;
      data.modelLines = models.lines;
      data.cache = { modelsCachedAt: models.cachedAt, modelsCacheHit: models.cacheHit };
      const usable = models.exitCode === 0 && models.ids.length > 0;
      data.signedIn = usable;
      if (!usable) {
        return envelope({
          ok: false,
          error: {
            code: "auth_required",
            message:
              `agy is installed (${discovered.version ?? "unknown version"}) but could not list models ` +
              `(exit ${models.exitCode ?? "null"}), which usually means it is not signed in. Run \`agy\` once in a ` +
              "terminal and complete the Google sign-in, then call agy_check again. agy has no `auth` subcommand, so " +
              "the model listing is the only cheap proof of a working sign-in.",
            retryable: true
          },
          data,
          warnings
        });
      }
    }
  }

  return envelope({ ok: true, data, warnings });
}

export async function agyRun(
  args: CommonArgs & {
    prompt: string;
    background?: boolean;
    timeoutMs?: number;
    allowCodexPrivatePaths?: boolean;
  }
) {
  return guarded(() => runOrStartJob({ ...args, kind: "run" }));
}

export async function agyContinue(
  args: CommonArgs & {
    conversationId: string;
    prompt: string;
    background?: boolean;
    timeoutMs?: number;
    allowCodexPrivatePaths?: boolean;
  }
) {
  return guarded(() => runOrStartJob({ ...args, kind: "continue" }));
}

export async function agyRescue(
  args: CommonArgs & { problem: string; background?: boolean; timeoutMs?: number }
) {
  const prompt = [
    "You are agy acting as an independent rescue reviewer for a Codex task.",
    "Return: Diagnosis, Minimal path forward, Commands to verify, Risks.",
    "",
    args.problem
  ].join("\n");
  return guarded(() => runOrStartJob({ ...args, kind: "rescue", prompt }));
}

export async function agyReview(
  args: CommonArgs & { target?: string; background?: boolean; timeoutMs?: number }
) {
  const target = args.target ?? "the current working tree";
  const prompt = [
    HEADLESS_DELEGATION_PREAMBLE,
    MIRROR_DISCLOSURE,
    "You are agy acting as a bounded second reviewer for Codex.",
    `Review ${target}.`,
    "This is not a full security scan. Inspect only the named target and directly relevant files; if the scope is " +
      "too broad, ask for a narrower target instead of expanding.",
    REVIEW_FILE_BUDGET_RULE,
    "Prioritize correctness bugs, regressions, risk-sensitive failure modes, and missing tests.",
    "Every finding must cite file:line. A verdict of no findings must be followed by an Inspected list naming the " +
      "files you actually opened; do not report a conclusion you did not read the code for.",
    "Return Findings first, then Open questions, then Test gaps, then Inspected. Keep it concise."
  ].join("\n");
  return guarded(() => runOrStartJob({ ...args, kind: "review", prompt, readOnly: true }));
}

export async function agyAdversarialReview(
  args: CommonArgs & {
    target?: string;
    threatModel?: string;
    background?: boolean;
    timeoutMs?: number;
  }
) {
  const target = args.target ?? "the current working tree";
  const prompt = [
    HEADLESS_DELEGATION_PREAMBLE,
    MIRROR_DISCLOSURE,
    "You are agy acting as a bounded failure-mode reviewer for Codex.",
    `Target: ${target}.`,
    ...threatModelRules(args.threatModel),
    "This is not a full security scan. Do not perform repo-wide discovery unless the target is explicitly repo-wide.",
    "Inspect only the named target and directly relevant files; if more scope is needed, say what is missing " +
      "instead of expanding.",
    REVIEW_FILE_BUDGET_RULE,
    // Neutral wording on purpose: the same review framed as attacker/malicious/attack
    // chain is what trips a client's own content filter mid-task.
    "Find hidden breakage paths, unsafe assumptions, permission/path/platform issues, and failure modes. Describe " +
      "them as failure modes and breakage paths, not as attacks.",
    "Report every finding you have, sorted by severity, and mark the five most severe as primary -- do not silently " +
      "drop the rest.",
    "Every finding must cite file:line and its in-model or out-of-model status. A verdict of no findings must be " +
      "followed by an Inspected list naming the files you actually opened.",
    "Return Findings (primary first), then Highest-risk assumption, Recommended verification, Inspected, and Scope " +
      "not inspected."
  ].join("\n");
  return guarded(() =>
    runOrStartJob({ ...args, kind: "adversarial_review", prompt, readOnly: true })
  );
}

export async function agyConversations(
  args: CommonArgs & { limit?: number; includeAllDirectories?: boolean }
) {
  return guarded(() => agyConversationsImpl(args));
}

async function agyConversationsImpl(
  args: CommonArgs & { limit?: number; includeAllDirectories?: boolean }
) {
  const warnings: string[] = [];
  // This tool reads only the plugin's own job records and never runs agy, so an
  // unavailable workspace degrades to an unscoped listing instead of refusing. It
  // is the call a caller makes precisely because something has gone wrong, and the
  // session that lost a job handle is often the session with no roots.
  let roots: string[] = [];
  try {
    roots = await resolvedWorkspaceRoots(
      args._workspaceRoots,
      args._workspaceRequestMeta,
      args._workspaceAdditionalSources
    );
  } catch (error) {
    if (!isBoundaryError(error)) throw error;
    warnings.push(
      "No workspace root was available, so this listing is not scoped to a project and shows every conversation " +
        "this plugin has a record of."
    );
  }

  const store = new JobStore();
  const listing = await listConversations({
    stateDir: store.stateDir,
    roots,
    includeAllDirectories: args.includeAllDirectories,
    limit: args.limit
  });

  warnings.push(
    "This lists the agy conversations THIS PLUGIN started, from its own job records. agy publishes no conversation " +
      "listing of its own: it has no `conversations` subcommand, its per-conversation state is protobuf inside " +
      "SQLite with no title or workspace column, and the one index file with the right columns is written by the " +
      "Antigravity desktop app rather than the CLI. A conversation started by a bare `agy` invocation cannot appear " +
      "here."
  );
  if (listing.skipped) {
    warnings.push(`${listing.skipped} job record(s) could not be read and were skipped.`);
  }
  if (!args.includeAllDirectories && !listing.conversations.length) {
    warnings.push(
      "No conversation from this workspace was found. Set includeAllDirectories:true to see conversations started " +
        "in other projects."
    );
  }

  return envelope({
    ok: true,
    data: {
      conversations: listing.conversations,
      returned: listing.conversations.length,
      scanned: listing.scanned,
      filteredToWorkspaceRoots: args.includeAllDirectories !== true
    },
    warnings
  });
}

/* ------------------------------------------------------------------------- */
/* Job observation                                                            */
/* ------------------------------------------------------------------------- */

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/** After this long, re-polling a terminal record is pure waste and says so. */
const STALE_TERMINAL_POLL_MS = 5 * 60_000;

/**
 * The part of a job response that describes the job's outcome rather than the
 * query's. `ok: true` on a record whose status is "failed" would leave polling as
 * the only viable strategy.
 */
function jobOutcomeEnvelope(job: JobRecord): {
  ok: boolean;
  terminal: boolean;
  nextAction: string;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
} {
  const terminal = TERMINAL_JOB_STATUSES.has(job.status);
  const warnings: string[] = [];
  if (terminal && job.finishedAt) {
    const finishedMsAgo = Date.now() - Date.parse(job.finishedAt);
    if (Number.isFinite(finishedMsAgo) && finishedMsAgo >= STALE_TERMINAL_POLL_MS) {
      warnings.push(
        `Job ${job.id} reached ${job.status} ${Math.round(finishedMsAgo / 60_000)} minutes ago. ` +
          "The record is final and cannot change; stop polling it."
      );
    }
  }
  const nextAction = terminal
    ? "do not poll again; the record is final"
    : "not terminal yet -- prefer one blocking waitMs over a poll loop, and do not call agy_status and agy_result " +
      "at the same instant: agy_result already contains the record";

  if (job.status === "cancelled") {
    return {
      ok: false,
      terminal,
      nextAction,
      warnings,
      error: {
        code: "cancelled",
        message: job.errorMessage ?? "The job was cancelled before producing a final result.",
        retryable: true
      }
    };
  }
  if (job.status === "failed") {
    const code = job.errorClass ?? "unknown";
    return {
      ok: false,
      terminal,
      nextAction,
      warnings,
      error: {
        code,
        message: job.errorMessage ?? agyFailureMessage(code),
        retryable: isRetryableAgyFailure(code)
      }
    };
  }
  return { ok: true, terminal, nextAction, warnings };
}

/**
 * Hard ceiling on a server-side wait, whatever the caller asks for. Codex aborts a
 * `tools/call` at 300s, so a longer wait would turn a poll into a lost call.
 */
export const MAX_WAIT_MS = 240_000;
const WAIT_POLL_MIN_MS = 500;
const WAIT_POLL_MAX_MS = 5_000;

/**
 * Block until the job is terminal or the budget runs out. Each round re-reads the
 * record from disk, so an agy_cancel issued elsewhere ends the wait too.
 */
async function waitForTerminal(
  store: JobStore,
  jobId: string,
  requestedWaitMs: number | undefined
): Promise<{ job: JobRecord; waited: number; warnings: string[] }> {
  const warnings: string[] = [];
  let job = await store.status(jobId);
  if (requestedWaitMs === undefined || requestedWaitMs <= 0) {
    return { job, waited: 0, warnings };
  }
  const budget = Math.min(requestedWaitMs, MAX_WAIT_MS);
  if (requestedWaitMs > MAX_WAIT_MS) {
    warnings.push(
      `waitMs=${requestedWaitMs} was clamped to ${MAX_WAIT_MS}: the MCP client aborts a tools/call at 300s, ` +
        "so a longer server-side wait would lose the call rather than return the record."
    );
  }
  const startedAt = Date.now();
  let delay = WAIT_POLL_MIN_MS;
  while (!TERMINAL_JOB_STATUSES.has(job.status)) {
    const remaining = budget - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await new Promise((done) => setTimeout(done, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, WAIT_POLL_MAX_MS);
    job = await store.status(jobId);
  }
  return { job, waited: Date.now() - startedAt, warnings };
}

export async function agyStatus(args: { jobId: string; waitMs?: number }) {
  return guarded(() => agyStatusImpl(args));
}

async function agyStatusImpl(args: { jobId: string; waitMs?: number }) {
  const store = new JobStore();
  const { job, waited, warnings: waitWarnings } = await waitForTerminal(store, args.jobId, args.waitMs);
  const outcome = jobOutcomeEnvelope(job);
  return envelope({
    ok: outcome.ok,
    error: outcome.error,
    warnings: [...waitWarnings, ...outcome.warnings],
    data: {
      terminal: outcome.terminal,
      nextAction: outcome.nextAction,
      job: toPublicJob(job),
      waited,
      agyConversationId: job.agyConversationId,
      observedModel: job.observedModel,
      resumable: job.resumable === true
    }
  });
}

export type ResultArgs = {
  jobId: string;
  maxChars?: number;
  view?: JobResultView;
  waitMs?: number;
};

export async function agyResult(args: ResultArgs) {
  return guarded(() => agyResultImpl(args));
}

async function agyResultImpl(args: ResultArgs) {
  const store = new JobStore();
  const { waited, warnings: waitWarnings } = await waitForTerminal(store, args.jobId, args.waitMs);
  const result = await store.result(args.jobId, args.maxChars, args.view);
  const outcome = jobOutcomeEnvelope(result.record);
  return envelope({
    ok: outcome.ok,
    error: outcome.error,
    warnings: [...waitWarnings, ...outcome.warnings, ...result.outputSummary.warnings],
    data: {
      terminal: outcome.terminal,
      nextAction: outcome.nextAction,
      ...result,
      record: toPublicJob(result.record),
      waited
    }
  });
}

export async function agyCancel(args: { jobId: string }) {
  return guarded(() => agyCancelImpl(args));
}

async function agyCancelImpl(args: { jobId: string }) {
  const store = new JobStore();
  const job = await store.cancel(args.jobId);
  const outcome = jobOutcomeEnvelope(job);
  return envelope({
    ok: outcome.ok,
    error: outcome.error,
    warnings: [
      ...outcome.warnings,
      "Cancelling abandons the agy conversation mid-turn. A job that runs out of budget instead keeps its " +
        "conversation id and can be resumed with agy_continue, so waiting is usually cheaper than cancelling."
    ],
    data: { terminal: outcome.terminal, nextAction: outcome.nextAction, job: toPublicJob(job) }
  });
}

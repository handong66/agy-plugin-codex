#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { timeoutSchema, TYPICAL_WALL_TIME_NOTE } from "./timeout-budget.js";
import { findCodexRolloutWorkspace, THREAD_ID_PATTERN } from "./codex-rollout.js";
import {
  agyAdversarialReview,
  agyCancel,
  agyCheck,
  agyContinue,
  agyConversations,
  agyRescue,
  agyResult,
  agyReview,
  agyRun,
  agyStatus,
  configureWorkspaceRootsProvider,
  type WorkspaceAdditionalSourcesDiagnostics,
  type WorkspaceCallerCwdDiagnostics,
  type WorkspaceConfiguredRootsDiagnostics,
  type WorkspaceRequestMetaDiagnostics,
  type WorkspaceRootsListDiagnostics,
  type WorkspaceRootsProviderResult
} from "./tools.js";

const server = new McpServer(
  {
    name: "agy-plugin-codex",
    // Keep in step with package.json and .codex-plugin/plugin.json; version-sync
    // fails the build when they drift, because this string is the version a caller
    // sees on the wire.
    version: "0.1.0"
  },
  {
    instructions:
      "Use these tools to delegate work to the Antigravity CLI (agy) from Codex. agy cannot see a directory it was " +
      "not given with --add-dir, and it cannot read without also being able to write, so read-only reviews run " +
      "against a disposable copy of the working tree. Codex remains the final owner of every change."
  }
);

function normalizedRootsListError(error: unknown): string {
  const issues =
    error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? error.issues
      : [];
  const rejectedNonFileRoot = issues.some((issue) => {
    if (!issue || typeof issue !== "object") return false;
    const record = issue as Record<string, unknown>;
    const path = Array.isArray(record.path) ? record.path : [];
    return record.format === "starts_with" && record.prefix === "file://" && path.at(-1) === "uri";
  });
  if (rejectedNonFileRoot) return "unsupported_root_protocol";
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "number"
      ? error.code
      : undefined;
  switch (code) {
    case ErrorCode.MethodNotFound:
      return "method_not_found";
    case ErrorCode.RequestTimeout:
      return "request_timeout";
    case ErrorCode.ParseError:
      return "parse_error";
    case ErrorCode.InvalidRequest:
      return "invalid_request";
    case ErrorCode.InvalidParams:
      return "invalid_params";
    case ErrorCode.InternalError:
      return "internal_error";
    default:
      return "request_failed";
  }
}

configureWorkspaceRootsProvider(async (): Promise<WorkspaceRootsProviderResult> => {
  const advertised = server.server.getClientCapabilities()?.roots !== undefined;
  try {
    const { roots } = await server.server.listRoots();
    const filesystemRoots: string[] = [];
    for (const root of roots) {
      let url: URL;
      try {
        url = new URL(root.uri);
      } catch {
        return {
          roots: [],
          diagnostics: { supported: true, ok: false, count: 0, errorCode: "invalid_root_uri" }
        };
      }
      if (url.protocol !== "file:") {
        return {
          roots: [],
          diagnostics: { supported: true, ok: false, count: 0, errorCode: "unsupported_root_protocol" }
        };
      }
      try {
        filesystemRoots.push(fileURLToPath(url));
      } catch {
        return {
          roots: [],
          diagnostics: { supported: true, ok: false, count: 0, errorCode: "invalid_root_uri" }
        };
      }
    }
    return {
      roots: filesystemRoots,
      diagnostics: { supported: true, ok: true, count: filesystemRoots.length }
    };
  } catch (error) {
    const errorCode = normalizedRootsListError(error);
    const diagnostics: WorkspaceRootsListDiagnostics = {
      supported: advertised || errorCode !== "method_not_found",
      ok: false,
      count: 0,
      errorCode
    };
    return { roots: [], diagnostics };
  }
});

const MAX_CODEX_TURN_METADATA_STRING_CHARS = 1_000_000;
const MISSING_VALUE_TYPE = "missing";
const NULL_VALUE_TYPE = "null";
const ARRAY_VALUE_TYPE = "array";

function valueType(value: unknown): string {
  if (value === undefined) return MISSING_VALUE_TYPE;
  if (value === null) return NULL_VALUE_TYPE;
  if (Array.isArray(value)) return ARRAY_VALUE_TYPE;
  return typeof value;
}

function decodeRecord(value: unknown): Record<string, unknown> | null {
  // Codex's own app-tools bridge accepts this metadata as either an object or a
  // JSON string. Plugin MCP calls can cross the same executor boundary, so mirror
  // that compatibility instead of silently discarding a serialized workspace map.
  let decoded = value;
  if (typeof value === "string") {
    if (value.length > MAX_CODEX_TURN_METADATA_STRING_CHARS) return null;
    try {
      decoded = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : null;
}

function codexWorkspaceContext(meta: unknown): {
  roots: string[];
  diagnostics: WorkspaceRequestMetaDiagnostics;
} {
  const metaPresent = meta !== undefined && meta !== null;
  const decodedMeta = decodeRecord(meta);
  const turnMetadataPresent = Boolean(
    decodedMeta && Object.prototype.hasOwnProperty.call(decodedMeta, "x-codex-turn-metadata")
  );
  const turnMetadata = decodedMeta?.["x-codex-turn-metadata"];
  const decodedTurnMetadata = decodeRecord(turnMetadata);
  const workspaces = decodedTurnMetadata?.workspaces;
  const roots =
    workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)
      ? Object.keys(workspaces).filter((root) => root.length <= 4_096 && isAbsolute(root))
      : [];
  return {
    roots,
    diagnostics: {
      metaPresent,
      turnMetadataPresent,
      turnMetadataType: valueType(turnMetadata),
      parseSucceeded: decodedTurnMetadata !== null,
      workspaceCount: roots.length
    }
  };
}

const MAX_CONFIGURED_WORKSPACE_ROOTS = 32;

async function codexSessionWorkspaceContext(meta: unknown): Promise<{
  roots: string[];
  diagnostics?: WorkspaceAdditionalSourcesDiagnostics["sessionMeta"];
}> {
  const decodedMeta = decodeRecord(meta);
  const metadataThreadId = decodedMeta?.threadId;
  const candidate =
    typeof metadataThreadId === "string" && THREAD_ID_PATTERN.test(metadataThreadId)
      ? metadataThreadId
      : process.env.CODEX_THREAD_ID;
  const threadId = candidate && THREAD_ID_PATTERN.test(candidate) ? candidate : undefined;
  if (!threadId) return { roots: [] };

  const workspace = await findCodexRolloutWorkspace({ threadId });
  const roots = workspace.cwd && isAbsolute(workspace.cwd) ? [workspace.cwd] : [];
  return {
    roots,
    diagnostics: {
      threadIdPresent: true,
      rolloutFound: workspace.rolloutFound,
      cwdPresent: workspace.cwd !== null,
      count: roots.length
    }
  };
}

function configuredWorkspaceContext(): {
  roots: string[];
  diagnostics?: WorkspaceConfiguredRootsDiagnostics;
} {
  const raw = process.env.AGY_WORKSPACE_ROOTS;
  if (raw === undefined || raw.trim() === "") return { roots: [] };

  const roots = raw.split(delimiter).filter((root) => root.length > 0);
  const ok =
    roots.length > 0 &&
    roots.length <= MAX_CONFIGURED_WORKSPACE_ROOTS &&
    roots.every((root) => root.length <= 4_096 && isAbsolute(root));
  return {
    roots: ok ? roots : [],
    diagnostics: {
      configured: true,
      ok,
      count: ok ? roots.length : 0,
      ...(ok ? {} : { errorCode: "invalid_configured_roots" })
    }
  };
}

function callerCwdWorkspaceContext(value: unknown): {
  roots: string[];
  diagnostics?: WorkspaceCallerCwdDiagnostics;
} {
  if (value === undefined) return { roots: [] };
  const ok = typeof value === "string" && value.length <= 4_096 && isAbsolute(value);
  return {
    roots: ok ? [value] : [],
    diagnostics: {
      provided: true,
      ok,
      count: ok ? 1 : 0,
      ...(ok ? {} : { errorCode: "invalid_caller_cwd" })
    }
  };
}

async function withCodexWorkspaceRoots<T extends Record<string, unknown>>(
  args: T,
  meta: unknown
): Promise<
  T & {
    _workspaceRoots: string[];
    _workspaceRequestMeta: WorkspaceRequestMetaDiagnostics;
    _workspaceAdditionalSources: WorkspaceAdditionalSourcesDiagnostics;
  }
> {
  const context = codexWorkspaceContext(meta);
  const session = await codexSessionWorkspaceContext(meta);
  const configured = configuredWorkspaceContext();
  const callerCwd = callerCwdWorkspaceContext(args.cwd);
  return {
    ...args,
    _workspaceRoots: [...context.roots, ...session.roots, ...configured.roots, ...callerCwd.roots],
    _workspaceRequestMeta: context.diagnostics,
    _workspaceAdditionalSources: {
      ...(session.diagnostics ? { sessionMeta: session.diagnostics } : {}),
      ...(configured.diagnostics ? { configuredRoots: configured.diagnostics } : {}),
      ...(callerCwd.diagnostics ? { callerCwd: callerCwd.diagnostics } : {})
    }
  };
}

/**
 * Shared schema fragments.
 *
 * They are defined once so every execution tool publishes the same floor, ceiling
 * and wording, and so a contract test can assert that without enumerating each
 * registration.
 */
const commonShape = {
  cwd: z
    .string()
    .min(1)
    .max(4_096)
    .optional()
    .describe(
      "Absolute working directory. This is the directory agy is given with --add-dir, and the only one it is told " +
        "about: it ignores the process working directory entirely, so without this it works inside its own state " +
        "directory. It is not a sandbox -- agy runs with permissions skipped -- so treat this as what agy is aimed " +
        "at, not as a wall around it. Defaults to another available workspace root."
    ),
  model: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Omit `model` for normal collaboration so agy uses its own default. Pass an explicit id only when the user " +
        "asked for that override. Use the id from agy_check's `models` (for example gemini-3.7-flash-low, " +
        "claude-sonnet-4-6) -- agy's own error message for an unknown model prints display names, which --model does " +
        "not accept. The model that actually answered is reported as observedModel, read off the run itself."
    ),
  effort: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("agy's reasoning-effort dial. Omit it to let agy choose.")
};

const jobIdSchema = z.string().regex(/^job_[A-Za-z0-9_-]{1,128}$/);

const conversationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/)
  .describe(
    "An agy conversation id, from a previous job's agyConversationId or from agy_conversations. Note that agy does " +
      "NOT fail on an id it cannot find: it warns, exits 0, and starts a fresh conversation with none of the earlier " +
      "context. This plugin detects that and reports it in warnings, so read them before trusting a continuation."
  );

/**
 * Read-only annotations for the tools that only observe. Without these a client in
 * goal mode evaluates an approval for every status and result call.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const;

const waitMsSchema = z
  .number()
  .int()
  .min(0)
  .max(3_600_000)
  .optional()
  .describe(
    "Block until the job is terminal, up to this many milliseconds (default 0: return immediately). " +
      "Any request above 240000 is clamped to 240000 and reported in warnings[], because the MCP client aborts a " +
      "tools/call at 300s. The record is re-read every round, so an agy_cancel from elsewhere ends the wait. " +
      "The response reports waited (ms) and terminal. Prefer one blocking wait over a poll loop."
  );

const backgroundSchema = z
  .boolean()
  .optional()
  .describe(
    "Default true. A background job survives this call, enforces the full timeoutMs, and returns a jobId to read " +
      "with agy_status / agy_result. background:false runs inline and is clamped to 240000ms."
  );

const allowCodexPrivatePathsSchema = z
  .boolean()
  .optional()
  .describe(
    "Allow prompt references to Codex private runtime paths such as ~/.codex. Off by default. This changes only " +
      "what the prompt may mention; it grants nothing. agy is only ever told about the directory passed to " +
      "--add-dir, but it runs with permissions skipped and is not confined to it, so do not treat this flag as the " +
      "only thing standing between agy and those paths."
  );

server.registerTool(
  "agy_check",
  {
    title: "Check agy",
    description:
      "Diagnose whether the Antigravity CLI is installed, signed in, and which models this account can reach, and " +
      "report the workspace roots this plugin can see. The result is stable for this session: call it once at the " +
      "start, not before every batch. agy has no `auth` subcommand, so the model listing is the only cheap proof of " +
      "a working sign-in; it is cached for the life of this MCP server process, and force:true re-reads it.",
    inputSchema: {
      cwd: commonShape.cwd,
      includeModels: z
        .boolean()
        .optional()
        .describe("Default true. Set false to skip the model listing, which is also the sign-in check."),
      force: z.boolean().optional().describe("Re-run discovery and the model listing instead of using the cache.")
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  async (args, extra) => agyCheck(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "agy_run",
  {
    title: "Run agy",
    description:
      "Start a bounded agy task in the workspace. Background by default; keep the returned jobId. " +
      "agy runs WRITE-CAPABLE: it has no read-only permission mode, so this tool can modify files in cwd. Use " +
      "agy_review or agy_adversarial_review when you want a review that cannot touch the repository. " +
      "Done means data.outputSummary.resultComplete === true -- nothing else counts.",
    inputSchema: {
      ...commonShape,
      prompt: z
        .string()
        .min(1)
        .max(250_000)
        .describe(
          "Task instructions for agy. Put the task text here, not in files. agy takes its prompt as a command-line " +
            "value, so a very large prompt is refused with prompt_too_large rather than failing in spawn."
        ),
      background: backgroundSchema,
      timeoutMs: timeoutSchema,
      allowCodexPrivatePaths: allowCodexPrivatePathsSchema
    }
  },
  async (args, extra) => agyRun(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "agy_continue",
  {
    title: "Continue agy Conversation",
    description:
      "Continue an existing agy conversation, which is also how a timed-out job is resumed: a timeout keeps the " +
      "conversation, so continue it rather than rerunning the work. Runs write-capable, like agy_run. " +
      "Two measured facts to read the response against: agy starts a FRESH conversation when the id is unknown " +
      "(warnings will say so), and its num_turns and token usage are cumulative over the conversation, so a deep " +
      "resume is slower and more expensive than the same question asked fresh.",
    inputSchema: {
      ...commonShape,
      conversationId: conversationIdSchema,
      prompt: z.string().min(1).max(250_000).describe("Message to send into the existing conversation."),
      background: backgroundSchema,
      timeoutMs: timeoutSchema,
      allowCodexPrivatePaths: allowCodexPrivatePathsSchema
    }
  },
  async (args, extra) => agyContinue(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "agy_rescue",
  {
    title: "agy Rescue",
    description:
      "Ask agy for an independent diagnosis of a stuck task. Runs write-capable in cwd: agy cannot be given read " +
      "access without write access, and unlike the two review tools this one is not isolated, because a rescue " +
      "often needs to run commands and try things in the real tree. Use agy_review if you want an opinion that " +
      "cannot touch the repository. Done means outputSummary.resultComplete === true.",
    inputSchema: {
      ...commonShape,
      problem: z.string().min(1).max(250_000),
      background: backgroundSchema,
      timeoutMs: timeoutSchema
    }
  },
  async (args, extra) => agyRescue(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "agy_review",
  {
    title: "agy Review",
    description:
      "Ask agy to review a named target such as the current diff, with a filesystem read-only guarantee: agy is " +
      "given a disposable copy of the working tree and is never told the repository's path, so nothing it does can " +
      "reach your files. The copy is built from git's tracked and untracked file list, so this requires a git " +
      "repository and files git ignores (node_modules, build output, .env) are absent from it. Bounded to about 20 " +
      "files. A verdict with outputSummary.toolCallCount === 0 is an opinion, not a review, and is never " +
      "resultComplete.",
    inputSchema: {
      ...commonShape,
      target: z
        .string()
        .min(1)
        .max(16_384)
        .optional()
        .describe("What to review, in words -- for example 'the uncommitted changes' or 'src/auth/*.ts'."),
      background: backgroundSchema,
      timeoutMs: timeoutSchema
    }
  },
  async (args, extra) => agyReview(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "agy_adversarial_review",
  {
    title: "agy Adversarial Review",
    description:
      "Ask agy to find hidden breakage paths and unsafe assumptions in a named target, with the same filesystem " +
      "read-only guarantee agy_review has: agy is given a disposable copy of the working tree and is never told the " +
      "repository's path. The copy is built from git's file list, so this requires a git repository and files git " +
      "ignores are absent from it. Bounded to about 20 files, and every finding cites file:line. Pass threatModel " +
      "when the user has stated one; out-of-model findings are advisory and never blockers.",
    inputSchema: {
      ...commonShape,
      target: z.string().min(1).max(16_384).optional(),
      threatModel: z
        .string()
        .min(1)
        .max(2_000)
        .optional()
        .describe(
          "The operating context findings are judged against, in the user's own terms (for example: single-user " +
            "local application, no network exposure). Every finding is then labelled in-model or out-of-model, and " +
            "an out-of-model finding is advisory only -- never a blocker, a NO_GO, or a reason to stop work in " +
            "progress. Supply it whenever the user has stated one."
        ),
      background: backgroundSchema,
      timeoutMs: timeoutSchema
    }
  },
  async (args, extra) => agyAdversarialReview(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "agy_conversations",
  {
    title: "List agy Conversations",
    description:
      "List the agy conversations this plugin started, so a lost jobId or conversation id can be recovered without " +
      "calling the agy CLI directly. Scoped to the current workspace roots by default. This reads the plugin's own " +
      "job records: agy publishes no conversation listing of its own, so a conversation started by a bare `agy` " +
      "invocation cannot appear here.",
    inputSchema: {
      cwd: commonShape.cwd,
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("How many conversations to return, most recent first. Default 20."),
      includeAllDirectories: z
        .boolean()
        .optional()
        .describe("Include conversations started outside the current workspace roots. Off by default.")
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  async (args, extra) => agyConversations(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "agy_status",
  {
    title: "agy Job Status",
    description: `Read a background agy job record. ${TYPICAL_WALL_TIME_NOTE}`,
    inputSchema: {
      jobId: jobIdSchema,
      waitMs: waitMsSchema
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  agyStatus
);

server.registerTool(
  "agy_result",
  {
    title: "agy Job Result",
    description:
      "Read stdout/stderr tail and outputSummary for a background agy job. outputSummary.finalText is agy's answer " +
      "and the stdout tail is evidence, not the answer. Only outputSummary.resultComplete means agy finished and " +
      "produced it; finalText can also be present with finalTextPartial true, which is a run that answered and then " +
      "hit an error. In agy 1.1.18, exit 0 covers SUCCESS, CANCELED, and silent wrong-workspace SUCCESS, so exit 0 " +
      "does not establish that the requested work happened.",
    inputSchema: {
      jobId: jobIdSchema,
      waitMs: waitMsSchema,
      view: z
        .enum(["raw", "final"])
        .optional()
        .describe(
          "'raw' (default) returns the stdout/stderr tails plus outputSummary. 'final' drops the tails and returns " +
            "outputSummary only, whose finalText carries the whole answer."
        ),
      maxChars: z
        .number()
        .int()
        .positive()
        .max(1_000_000)
        .optional()
        .describe(
          "Requested tail size per stream. The effective range is 1..100000 and the default is 20000; a larger " +
            "request is clamped to 100000 and the response reports maxChars and maxCharsClamped. Widening this " +
            "window is not how to reach the final answer -- read outputSummary instead."
        )
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  agyResult
);

server.registerTool(
  "agy_cancel",
  {
    title: "Cancel agy Job",
    description:
      "Cancel a running agy job. Cancelling abandons the conversation mid-turn, while a job that runs out of budget " +
      "keeps its conversation id and can be resumed with agy_continue -- so prefer waiting.",
    inputSchema: {
      jobId: jobIdSchema
    }
  },
  agyCancel
);

const transport = new StdioServerTransport();
await server.connect(transport);

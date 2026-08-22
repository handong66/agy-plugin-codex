/**
 * Boundary refusals with stable codes.
 *
 * A refusal has to say what it is and what would make it succeed, otherwise every
 * rejection reaches the caller as a bare exception with no code to branch on. The
 * codes shared with the sibling Codex plugins (`workspace_unavailable`,
 * `workspace_out_of_bounds`, `private_path_blocked`, `cli_not_found`,
 * `cli_probe_timeout`, `job_not_found`, `state_write_failed`) are reused verbatim so
 * one orchestrator driving several of these plugins learns one table.
 *
 * Two codes are specific to agy and exist because agy's own runtime forces them:
 *
 * - `workspace_required`: agy ignores the process working directory entirely and
 *   can only see what `--add-dir` hands it, so a run with no resolvable workspace
 *   is not a degraded run, it is a run that would operate inside
 *   `~/.gemini/antigravity-cli` and see none of the repository.
 * - `mirror_failed`: a read-only review is isolated by giving agy a throwaway copy
 *   of the working tree instead of the repository. If that copy cannot be built,
 *   the review must not silently fall back to handing over the real tree.
 */
export type BoundaryErrorCode =
  | "workspace_unavailable"
  | "workspace_out_of_bounds"
  | "workspace_required"
  | "file_attachment_invalid"
  | "private_path_blocked"
  | "prompt_too_large"
  | "mirror_failed"
  | "state_write_failed"
  | "cli_not_found"
  | "cli_probe_timeout"
  | "job_not_found"
  | "model_not_found";

/**
 * Retrying the same call unchanged: only a probe timeout can plausibly succeed
 * later (a cold binary that answered slowly once may answer in time next call).
 */
const BOUNDARY_RETRYABLE: Record<BoundaryErrorCode, boolean> = {
  workspace_unavailable: false,
  workspace_out_of_bounds: false,
  workspace_required: false,
  file_attachment_invalid: false,
  private_path_blocked: false,
  prompt_too_large: false,
  mirror_failed: false,
  state_write_failed: false,
  cli_not_found: false,
  cli_probe_timeout: true,
  job_not_found: false,
  model_not_found: false
};

export class BoundaryError extends Error {
  readonly code: BoundaryErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: BoundaryErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BoundaryError";
    this.code = code;
    this.retryable = BOUNDARY_RETRYABLE[code];
    this.details = details;
  }
}

export function isBoundaryError(value: unknown): value is BoundaryError {
  return value instanceof BoundaryError;
}

/**
 * The sentence that resolves the common out-of-bounds refusal: a newly created
 * worktree or sibling checkout is rejected until Codex's per-call workspace
 * metadata knows about it.
 */
export const WORKSPACE_ROOTS_EXPLANATION =
  "These are the per-call Codex workspace roots. A directory Codex does not have in its workspace is rejected, so " +
  "add it there (or pass a cwd inside an existing root) rather than working around this.";

export function workspaceOutOfBounds(candidate: string, roots: string[]): BoundaryError {
  return new BoundaryError(
    "workspace_out_of_bounds",
    `Working directory is outside the MCP workspace roots: ${candidate}. ` +
      `Available roots: ${roots.length ? roots.join(", ") : "(none)"}. ${WORKSPACE_ROOTS_EXPLANATION}`,
    { candidate, roots }
  );
}

export function workspaceUnavailable(message: string, details?: Record<string, unknown>): BoundaryError {
  return new BoundaryError("workspace_unavailable", message, details);
}

/**
 * No job record under that id.
 *
 * This is the one call a caller makes precisely because it has lost its handle, so
 * it must not answer with a raw ENOENT carrying the absolute path of a private
 * state directory. The id is the only thing echoed back.
 */
export function jobNotFound(jobId: string): BoundaryError {
  return new BoundaryError(
    "job_not_found",
    `No agy job record for "${jobId}". Job ids come back from agy_run / agy_continue / agy_review / ` +
      "agy_adversarial_review / agy_rescue, and are private to the machine and state directory that started them. " +
      "If the handle is lost, agy_conversations lists the agy conversations this machine can resume with agy_continue.",
    { jobId }
  );
}

/**
 * Wrap a filesystem write to the private state directory, so a full or unwritable
 * disk names the directory that failed instead of surfacing a bare errno.
 */
export function stateWriteFailed(error: unknown, stateDir: string): BoundaryError {
  const errno = error as NodeJS.ErrnoException;
  const reason = errno?.code ? `${errno.code}: ${errno.message}` : String(errno?.message ?? error);
  return new BoundaryError(
    "state_write_failed",
    `Could not write the agy job state under ${stateDir} (${reason}). ` +
      "The job record, not agy, is what failed: free space or fix permissions on that directory, then retry. " +
      "Set AGY_PLUGIN_STATE_DIR to move the state elsewhere.",
    { stateDir, errno: errno?.code }
  );
}

/**
 * The prompt does not fit in an argv.
 *
 * agy takes its prompt as the value of `-p`, with no stdin path, so a prompt is
 * bounded by the operating system's argument-size limit rather than by anything
 * this plugin chooses. Refusing here names the real number instead of letting
 * `spawn` fail with a bare E2BIG.
 */
export function promptTooLarge(bytes: number, maxBytes: number): BoundaryError {
  return new BoundaryError(
    "prompt_too_large",
    `The prompt is ${bytes} UTF-8 bytes and the limit is ${maxBytes}. agy takes its prompt as a command-line value ` +
      "and has no stdin input path, so the prompt has to fit in the process argument list. Shorten it, or put the " +
      "bulk in files inside the workspace and ask agy to read them.",
    { bytes, maxBytes }
  );
}

/**
 * A read-only review could not be isolated.
 *
 * Read-only here is a filesystem guarantee, not a prompt: agy is handed a throwaway
 * copy of the working tree and is never told the repository's path. When the copy
 * cannot be built there is no weaker version of that guarantee to fall back to, so
 * the review is refused rather than pointed at the real tree.
 */
export function mirrorFailed(reason: string, details?: Record<string, unknown>): BoundaryError {
  return new BoundaryError(
    "mirror_failed",
    `Could not build the disposable workspace copy this read-only review needs: ${reason}. ` +
      "In the agy 1.1.18 E1 measurement, a denied tool call terminated the run and cleared its answer, so the " +
      "review avoids that permission gate by giving agy a copy with permissions skipped. Without that copy the " +
      "repository path cannot be withheld, so the review is refused rather than run against the real working tree. " +
      "Use agy_run if you intend agy to work in the repository itself.",
    details
  );
}

/**
 * agy cannot fall back to a process working directory the way other CLIs can.
 *
 * Measured: launched from a repository without `--add-dir`, agy reported its
 * working directory as `~/.gemini/antigravity-cli`, could not see the repository's
 * files, and created a file in its own state directory. So "no workspace" is not a
 * degraded run to warn about; it is a run that must not be started.
 */
export function workspaceRequired(details?: Record<string, unknown>): BoundaryError {
  return new BoundaryError(
    "workspace_required",
    "No workspace directory could be resolved for this agy run. agy does not inherit the process working directory: " +
      "without --add-dir it operates inside ~/.gemini/antigravity-cli and can see none of the repository, so a run " +
      "with no workspace would silently do its work in agy's own state directory. Provide an explicit absolute cwd, " +
      "a standard MCP roots/list, per-call Codex workspace metadata, or AGY_WORKSPACE_ROOTS. agy_check reports which " +
      "source was absent or unusable.",
    details
  );
}

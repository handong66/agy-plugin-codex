import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BoundaryError,
  isBoundaryError,
  jobNotFound,
  mirrorFailed,
  promptTooLarge,
  stateWriteFailed,
  workspaceOutOfBounds,
  workspaceRequired,
  workspaceUnavailable,
  type BoundaryErrorCode
} from "../plugins/agy-plugin-codex/src/boundary.js";

/**
 * Every code in the union, written out rather than derived, so a code added to the
 * source without a retryable verdict fails this file instead of passing silently.
 */
const ALL_CODES: BoundaryErrorCode[] = [
  "workspace_unavailable",
  "workspace_out_of_bounds",
  "workspace_required",
  "file_attachment_invalid",
  "private_path_blocked",
  "prompt_too_large",
  "mirror_failed",
  "state_write_failed",
  "cli_not_found",
  "cli_probe_timeout",
  "job_not_found",
  "model_not_found"
];

const RETRYABLE_CODES = new Set<BoundaryErrorCode>(["cli_probe_timeout"]);

function codesDeclaredInSource(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../plugins/agy-plugin-codex/src/boundary.ts", import.meta.url)),
    "utf8"
  );
  const union = source.match(/export type BoundaryErrorCode =([\s\S]*?);/);
  if (!union) throw new Error("BoundaryErrorCode union not found in boundary.ts");
  return [...union[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

describe("BoundaryErrorCode", () => {
  it("has a retryable verdict for every code the union declares", () => {
    const declared = codesDeclaredInSource();

    // The hardcoded list above is what the rest of this file asserts against; if the
    // union grows, this is the assertion that notices.
    expect(declared).toHaveLength(ALL_CODES.length);
    expect([...declared].sort()).toEqual([...ALL_CODES].sort());
  });

  it("marks every code non-retryable except a probe timeout", () => {
    for (const code of ALL_CODES) {
      const error = new BoundaryError(code, `refused: ${code}`);

      expect(error.code).toBe(code);
      expect(typeof error.retryable).toBe("boolean");
      // Only a cold binary that answered slowly once can plausibly answer in time on
      // an identical retry; every other refusal is a decision about the request.
      expect(error.retryable).toBe(RETRYABLE_CODES.has(code));
    }
  });

  it("is a real Error carrying its details", () => {
    const error = new BoundaryError("job_not_found", "gone", { jobId: "j1" });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BoundaryError");
    expect(error.message).toBe("gone");
    expect(error.details).toEqual({ jobId: "j1" });
  });
});

describe("workspaceOutOfBounds", () => {
  it("names the rejected directory, the roots that were allowed, and how to add one", () => {
    const error = workspaceOutOfBounds("/elsewhere/repo", ["/work/a", "/work/b"]);

    expect(error.code).toBe("workspace_out_of_bounds");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("/elsewhere/repo");
    expect(error.message).toContain("/work/a");
    expect(error.message).toContain("/work/b");
    // A newly created worktree is rejected until Codex's workspace metadata knows
    // about it, so the remedy has to be stated or the caller works around it.
    expect(error.message).toContain("add it there");
    expect(error.details).toEqual({ candidate: "/elsewhere/repo", roots: ["/work/a", "/work/b"] });
  });

  it("says so plainly when there were no roots at all", () => {
    expect(workspaceOutOfBounds("/repo", []).message).toContain("(none)");
  });
});

describe("workspaceUnavailable", () => {
  it("carries the caller's own explanation under a stable code", () => {
    const error = workspaceUnavailable("The mirror source /repo disappeared mid-copy.", { path: "/repo" });

    expect(error.code).toBe("workspace_unavailable");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("/repo");
    expect(error.details).toEqual({ path: "/repo" });
  });
});

describe("jobNotFound", () => {
  it("echoes the id and points at the way to recover a lost handle", () => {
    const error = jobNotFound("job-4f2c");

    expect(error.code).toBe("job_not_found");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("job-4f2c");
    expect(error.message).toContain("agy_conversations");
    expect(error.details).toEqual({ jobId: "job-4f2c" });
  });

  it("never leaks the absolute path of the private state directory", () => {
    const error = jobNotFound("job-4f2c");

    // This is the one call a caller makes precisely because it has lost its handle,
    // so it must not answer with a raw ENOENT carrying a private path.
    expect(error.message).not.toMatch(/\/\S/);
    expect(error.message).not.toContain(homedir());
    expect(error.message).not.toContain(tmpdir());
  });
});

describe("stateWriteFailed", () => {
  it("blames the state directory rather than agy, and names the override", () => {
    const errno = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    const error = stateWriteFailed(errno, "/var/state/agy-plugin-codex");

    expect(error.code).toBe("state_write_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("/var/state/agy-plugin-codex");
    expect(error.message).toContain("ENOSPC");
    // The job record, not agy, is what failed -- and the directory is movable.
    expect(error.message).toContain("AGY_PLUGIN_STATE_DIR");
    expect(error.details).toEqual({ stateDir: "/var/state/agy-plugin-codex", errno: "ENOSPC" });
  });

  it("still produces a usable reason for a non-errno failure", () => {
    const error = stateWriteFailed(new Error("disk went away"), "/var/state/agy-plugin-codex");

    expect(error.message).toContain("disk went away");
    expect(error.message).toContain("AGY_PLUGIN_STATE_DIR");
  });
});

describe("promptTooLarge", () => {
  it("names both byte numbers, since the limit is a byte limit and not a character one", () => {
    const error = promptTooLarge(600_000, 524_288);

    expect(error.code).toBe("prompt_too_large");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("600000");
    expect(error.message).toContain("524288");
    // agy takes its prompt as a command-line value and has no stdin input path.
    expect(error.message).toContain("stdin");
    expect(error.details).toEqual({ bytes: 600_000, maxBytes: 524_288 });
  });
});

describe("mirrorFailed", () => {
  it("explains why a read-only review cannot fall back to the real tree", () => {
    const error = mirrorFailed("EACCES copying /repo/.git", { source: "/repo" });

    expect(error.code).toBe("mirror_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("EACCES copying /repo/.git");
    // agy cannot separate read permission from write permission, so isolation is the
    // throwaway copy. Without it there is no weaker guarantee to degrade to.
    expect(error.message).toContain("no read-only permission mode");
    expect(error.message).toContain("agy_run");
    expect(error.details).toEqual({ source: "/repo" });
  });
});

describe("workspaceRequired", () => {
  it("explains that agy ignores the process working directory", () => {
    const error = workspaceRequired({ sources: ["cwd", "roots"] });

    expect(error.code).toBe("workspace_required");
    expect(error.retryable).toBe(false);
    // Measured: without --add-dir agy operates inside ~/.gemini/antigravity-cli and
    // sees none of the repository, so this is a run that must not be started rather
    // than a degraded run to warn about.
    expect(error.message).toContain("does not inherit the process working directory");
    expect(error.message).toContain("--add-dir");
    expect(error.message).toContain("agy_check");
    expect(error.details).toEqual({ sources: ["cwd", "roots"] });
  });
});

describe("isBoundaryError", () => {
  it("recognises a boundary refusal and nothing else", () => {
    expect(isBoundaryError(workspaceRequired())).toBe(true);
    expect(isBoundaryError(new BoundaryError("cli_not_found", "missing"))).toBe(true);

    // A plain Error carries no code and no retryable verdict, which is exactly what
    // callers branch on.
    expect(isBoundaryError(new Error("missing"))).toBe(false);
    expect(isBoundaryError(new TypeError("missing"))).toBe(false);
    expect(isBoundaryError({ code: "cli_not_found", message: "missing" })).toBe(false);
    expect(isBoundaryError(undefined)).toBe(false);
    expect(isBoundaryError("cli_not_found")).toBe(false);
  });
});

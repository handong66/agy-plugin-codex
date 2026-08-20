import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agyAdversarialReview,
  agyReview,
  configureWorkspaceRootsProvider
} from "../plugins/agy-plugin-codex/src/tools.js";
import { isRetryableAgyFailure } from "../plugins/agy-plugin-codex/src/agy-cli.js";
import { refusalOf } from "./helpers/envelope.js";

/**
 * A read-only review outside a git repository has to fail the same way whether it
 * was asked for in the foreground or the background.
 *
 * The background path used to return ok:true with a jobId and only die inside the
 * worker, where the typed refusal was flattened into `worker_error` -- a class the
 * Skill does not publish and that `isRetryableAgyFailure` calls retryable. So the
 * caller was told to retry a call that cannot succeed until the directory becomes a
 * git repository.
 */

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  configureWorkspaceRootsProvider(async () => [process.cwd()]);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("a read-only review outside a git repository", () => {
  for (const [label, background] of [
    ["foreground", false],
    ["background", true]
  ] as const) {
    it(`refuses with mirror_failed, non-retryable, in the ${label}`, async () => {
      const workspace = await tempDir("agy-nogit-");
      await writeFile(join(workspace, "a.txt"), "hello\n");
      configureWorkspaceRootsProvider(async () => [workspace]);

      const error = await refusalOf(() =>
        agyReview({ cwd: workspace, target: "a.txt", background })
      );

      expect(error.code).toBe("mirror_failed");
      expect(error.retryable).toBe(false);
      // The refusal has to explain the alternative, or the caller's only move is to
      // guess. agy_run is the tool that works in the tree itself.
      expect(error.message).toContain("git repository");
      expect(error.message).toContain("agy_run");
    });
  }

  it("refuses the adversarial review the same way", async () => {
    const workspace = await tempDir("agy-nogit-adv-");
    configureWorkspaceRootsProvider(async () => [workspace]);

    const error = await refusalOf(() => agyAdversarialReview({ cwd: workspace, background: true }));
    expect(error.code).toBe("mirror_failed");
    expect(error.retryable).toBe(false);
  });

  it("treats mirror_failed as non-retryable wherever it lands as a job class", () => {
    // Defence in depth: if a mirror ever fails inside the worker anyway, the class
    // that reaches the caller must still not invite a retry.
    expect(isRetryableAgyFailure("mirror_failed")).toBe(false);
    expect(isRetryableAgyFailure("prompt_too_large")).toBe(false);
  });
});

describe("a read-only review inside a git repository", () => {
  it("gets past the pre-check", async () => {
    const workspace = await tempDir("agy-git-");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    await writeFile(join(workspace, "a.txt"), "hello\n");
    git("add", ".");
    git("commit", "-qm", "seed");
    configureWorkspaceRootsProvider(async () => [workspace]);

    // No agy binary is needed: the pre-check runs before submission, so anything
    // other than a mirror_failed refusal proves it passed.
    const result = (await agyReview({ cwd: workspace, target: "a.txt", background: true }))
      .structuredContent as { ok: boolean; error?: { code: string } };
    expect(result.error?.code).not.toBe("mirror_failed");
  });
});

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isBoundaryError } from "../plugins/agy-plugin-codex/src/boundary.js";
import {
  compareFingerprints,
  createReadOnlyMirror,
  diffMirrorSnapshots,
  fingerprintTree,
  listMirrorFiles,
  rewriteMirrorPaths,
  snapshotMirror
} from "../plugins/agy-plugin-codex/src/readonly-mirror.js";

/**
 * The read-only guarantee this plugin publishes is a filesystem guarantee: agy has
 * no read-only permission mode, so a review is made read-only by handing agy a
 * throwaway copy of the working tree and never telling it the repository's path.
 * Everything in this file is a test of that copy, because the copy IS the promise.
 */

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix = "agy-mirror-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function gitOut(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

async function writeIn(repo: string, relativePath: string, contents: string): Promise<string> {
  const full = join(repo, relativePath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, contents);
  return full;
}

/** A repository with one commit, so both HEAD and working-tree state exist. */
async function makeRepo(): Promise<string> {
  const repo = await makeTempDir("agy-mirror-repo-");
  git(repo, ["init", "-q", "-b", "main", "."]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "agy plugin test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeIn(repo, "tracked.txt", "committed contents\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

describe.skipIf(!hasGit)("listMirrorFiles decides what a read-only review is allowed to see", () => {
  it("includes tracked files and untracked files that are not ignored", async () => {
    const repo = await makeRepo();
    await writeIn(repo, "untracked.txt", "not committed yet\n");

    const files = await listMirrorFiles(repo);

    expect(files).not.toBeNull();
    expect(files).toContain("tracked.txt");
    // Uncommitted work is usually the point of the review, so an untracked file
    // that git would show in `status` has to reach the copy.
    expect(files).toContain("untracked.txt");
  });

  it("excludes everything .gitignore matches, because that is the expensive and dangerous half of a naive copy", async () => {
    const repo = await makeRepo();
    await writeIn(repo, ".gitignore", "node_modules/\n.env\n");
    await writeIn(repo, ".env", "SECRET=hunter2\n");
    await writeIn(repo, "node_modules/left-pad/index.js", "module.exports = 1;\n");

    const files = await listMirrorFiles(repo);

    expect(files).toContain(".gitignore");
    expect(files).not.toContain(".env");
    expect(files?.some((path) => path.startsWith("node_modules/"))).toBe(false);
  });

  it("excludes a file that is in the index but gone from the working tree", async () => {
    const repo = await makeRepo();
    await writeIn(repo, "doomed.txt", "about to be removed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add doomed"]);
    await rm(join(repo, "doomed.txt"));

    // Verified against git directly first: an on-disk deletion that has not been
    // staged is what `git ls-files --deleted` reports, and it is still listed by
    // `--cached`. Copying it back would show the reviewer a file the author removed.
    expect(gitOut(repo, ["ls-files", "--deleted"]).trim()).toBe("doomed.txt");
    expect(gitOut(repo, ["ls-files", "--cached"])).toContain("doomed.txt");

    const files = await listMirrorFiles(repo);

    expect(files).toContain("tracked.txt");
    expect(files).not.toContain("doomed.txt");
  });

  it("returns null for a directory that is not a git repository", async () => {
    const plain = await makeTempDir("agy-mirror-plain-");
    await writeFile(join(plain, "a.txt"), "hello\n");

    expect(await listMirrorFiles(plain)).toBeNull();
  });
});

describe.skipIf(!hasGit)("createReadOnlyMirror refuses rather than falling back to the real tree", () => {
  it("rejects a non-repository with a mirror_failed boundary error and copies nothing", async () => {
    const plain = await makeTempDir("agy-mirror-plain-");
    await writeFile(join(plain, "secret.env"), "SECRET=hunter2\n");

    // There is deliberately no fallback that copies an arbitrary directory tree:
    // without git's file list there is no way to exclude ignored paths, so the
    // review is refused instead of running against (or copying) the real tree.
    const error = await createReadOnlyMirror(plain).then(
      () => null,
      (reason: unknown) => reason
    );

    expect(error).not.toBeNull();
    expect(isBoundaryError(error)).toBe(true);
    expect(isBoundaryError(error) && error.code).toBe("mirror_failed");
    expect(isBoundaryError(error) && error.retryable).toBe(false);
  });
});

describe.skipIf(!hasGit)("the mirror reproduces the working tree, not HEAD", () => {
  it("holds the uncommitted bytes of a modified file", async () => {
    const repo = await makeRepo();
    await writeIn(repo, "tracked.txt", "MODIFIED but not committed\n");

    const mirror = await createReadOnlyMirror(repo, { tmpRoot: await makeTempDir("agy-mirror-root-") });
    try {
      const mirrored = await readFile(join(mirror.path, "tracked.txt"), "utf8");
      // A `git worktree add` would have checked out HEAD and lost exactly this,
      // which is the change the review was usually asked about.
      expect(mirrored).toBe("MODIFIED but not committed\n");
      expect(mirrored).not.toContain("committed contents");
    } finally {
      await mirror.cleanup();
    }
  });

  it("lives outside the repository, leaves the repository unchanged, and cleans itself up", async () => {
    const repo = await makeRepo();
    await writeIn(repo, "untracked.txt", "u\n");
    const before = await fingerprintTree(repo);

    const mirror = await createReadOnlyMirror(repo, { tmpRoot: await makeTempDir("agy-mirror-root-") });

    // agy is only ever told the mirror path, so the mirror must not sit inside the
    // repository -- otherwise "the repository was never given to it" is false.
    expect(mirror.path.startsWith(`${repo}${sep}`)).toBe(false);
    expect(relative(repo, mirror.path).startsWith("..")).toBe(true);
    expect(mirror.fileCount).toBeGreaterThan(0);

    const after = await fingerprintTree(repo);
    expect(compareFingerprints(before, after)).toBeNull();
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);

    await mirror.cleanup();
    expect(existsSync(mirror.path)).toBe(false);
  });

  it("keeps the executable bit, because whether a script is executable is sometimes the thing under review", async () => {
    const repo = await makeRepo();
    await writeIn(repo, "run.sh", "#!/bin/sh\necho hi\n");
    await chmod(join(repo, "run.sh"), 0o755);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add script"]);

    const mirror = await createReadOnlyMirror(repo, { tmpRoot: await makeTempDir("agy-mirror-root-") });
    try {
      const mode = (await stat(join(mirror.path, "run.sh"))).mode & 0o777;
      expect(mode).toBe(0o755);
    } finally {
      await mirror.cleanup();
    }
  });
});

describe.skipIf(!hasGit)("symlinks are the one way a copy could stay writable into the real repository", () => {
  it("reproduces a symlink that points inside the tree as a symlink", async () => {
    const repo = await makeRepo();
    await symlink("tracked.txt", join(repo, "alias.txt"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add inside symlink"]);

    const mirror = await createReadOnlyMirror(repo, { tmpRoot: await makeTempDir("agy-mirror-root-") });
    try {
      const stats = await lstat(join(mirror.path, "alias.txt"));
      expect(stats.isSymbolicLink()).toBe(true);
      expect(await readlink(join(mirror.path, "alias.txt"))).toBe("tracked.txt");
      expect(mirror.skipped.map((skip) => skip.path)).not.toContain("alias.txt");
    } finally {
      await mirror.cleanup();
    }
  });

  it("skips an absolute symlink and a relative symlink that climbs out of the tree, and reports degraded", async () => {
    const repo = await makeRepo();
    const outside = await makeTempDir("agy-mirror-outside-");
    await writeFile(join(outside, "outside.txt"), "outside the tree\n");

    // Reproduced verbatim, either of these keeps pointing at whatever it pointed
    // at -- a writable door straight back into the real repository, which would
    // make the isolation a path convention rather than a filesystem guarantee.
    await symlink(join(outside, "outside.txt"), join(repo, "absolute-link.txt"));
    await mkdir(join(repo, "nested"), { recursive: true });
    await symlink("../../escape.txt", join(repo, "nested", "climbing-link.txt"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add escaping symlinks"]);

    const mirror = await createReadOnlyMirror(repo, { tmpRoot: await makeTempDir("agy-mirror-root-") });
    try {
      const reasons = new Map(mirror.skipped.map((skip) => [skip.path, skip.reason]));
      expect(reasons.get("absolute-link.txt")).toBe("symlink-escapes-tree");
      expect(reasons.get("nested/climbing-link.txt")).toBe("symlink-escapes-tree");
      expect(existsSync(join(mirror.path, "absolute-link.txt"))).toBe(false);
      expect(existsSync(join(mirror.path, "nested", "climbing-link.txt"))).toBe(false);
      // A review that could not see everything has to be able to say so.
      expect(mirror.degraded).toBe(true);
    } finally {
      await mirror.cleanup();
    }
  });
});

describe.skipIf(!hasGit)("fingerprintTree checks the isolation argument after the fact", () => {
  it("compares two identical readings to null", async () => {
    const repo = await makeRepo();
    expect(compareFingerprints(await fingerprintTree(repo), await fingerprintTree(repo))).toBeNull();
  });

  it("warns when the working tree changed while a read-only run was in flight", async () => {
    const repo = await makeRepo();
    const before = await fingerprintTree(repo);
    await writeIn(repo, "tracked.txt", "someone else touched this\n");
    const after = await fingerprintTree(repo);

    const warning = compareFingerprints(before, after);
    expect(warning?.class).toBe("tree_changed_during_readonly_run");
    expect(warning?.message).toContain("tree_changed_during_readonly_run");
  });

  it("warns when HEAD moved, even though the working tree ends up clean again", async () => {
    const repo = await makeRepo();
    const before = await fingerprintTree(repo);
    await writeIn(repo, "tracked.txt", "a new commit\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "second"]);
    const after = await fingerprintTree(repo);

    // status alone is clean after the commit, so HEAD is the only thing that
    // catches this.
    expect(before?.status).toBe(after?.status);
    expect(before?.head).not.toBe(after?.head);
    expect(compareFingerprints(before, after)?.class).toBe("tree_changed_during_readonly_run");
  });

  it("stays silent when either reading is missing, because an unknown is not a warning", async () => {
    const repo = await makeRepo();
    const fingerprint = await fingerprintTree(repo);
    expect(compareFingerprints(null, fingerprint)).toBeNull();
    expect(compareFingerprints(fingerprint, null)).toBeNull();
  });
});

describe("snapshotMirror names the writes a read-only run made inside the copy", () => {
  it("returns null when the run left the copy exactly as it found it", async () => {
    const mirrorPath = await makeTempDir("agy-mirror-snap-");
    await writeFile(join(mirrorPath, "a.txt"), "one\n");

    const before = await snapshotMirror(mirrorPath);
    const after = await snapshotMirror(mirrorPath);

    expect(diffMirrorSnapshots(before, after)).toBeNull();
    expect(diffMirrorSnapshots(null, after)).toBeNull();
    expect(diffMirrorSnapshots(before, null)).toBeNull();
  });

  it("reports a created, a modified and a deleted file in the right array and says the repository is unchanged", async () => {
    const mirrorPath = await makeTempDir("agy-mirror-snap-");
    await writeFile(join(mirrorPath, "kept.txt"), "kept\n");
    await writeFile(join(mirrorPath, "edited.txt"), "short\n");
    await mkdir(join(mirrorPath, "nested"), { recursive: true });
    await writeFile(join(mirrorPath, "nested", "doomed.txt"), "doomed\n");

    const before = await snapshotMirror(mirrorPath);

    await writeFile(join(mirrorPath, "created.txt"), "brand new\n");
    // The snapshot stamp is `size:mtimeMs`, and mtime granularity is coarse enough
    // that a same-size rewrite inside the same tick can compare equal. Changing the
    // length as well makes the assertion deterministic instead of timing-dependent.
    await writeFile(join(mirrorPath, "edited.txt"), "a decidedly longer replacement body\n");
    await rm(join(mirrorPath, "nested", "doomed.txt"));

    const warning = diffMirrorSnapshots(before, await snapshotMirror(mirrorPath));

    expect(warning?.class).toBe("readonly_run_wrote_files");
    expect(warning?.files?.added).toEqual(["created.txt"]);
    expect(warning?.files?.changed).toEqual(["edited.txt"]);
    expect(warning?.files?.removed).toEqual([join("nested", "doomed.txt")]);
    expect(warning?.files?.changed).not.toContain("kept.txt");
    // The whole point of the message: edits happened, but not to anything the user
    // owns, so a caller must not read the answer as "the files were fixed".
    expect(warning?.message).toContain("Your repository was never given to it and is unchanged");
  });
});

describe("rewriteMirrorPaths puts findings back on paths the user can actually open", () => {
  it("replaces the mirror prefix with the repository root", async () => {
    const mirrorPath = await makeTempDir("agy-review-");
    const repoRoot = "/Users/someone/projects/thing";

    const rewritten = await rewriteMirrorPaths(
      `Bug at ${mirrorPath}/src/index.ts:12 and again at ${mirrorPath}/src/util.ts:4`,
      mirrorPath,
      repoRoot
    );

    expect(rewritten).toBe(`Bug at ${repoRoot}/src/index.ts:12 and again at ${repoRoot}/src/util.ts:4`);
    expect(rewritten).not.toContain(mirrorPath);
  });

  it("leaves an unrelated temp path alone, so a finding about a temp directory of its own survives", async () => {
    const mirrorPath = await makeTempDir("agy-review-");
    const unrelated = await makeTempDir("something-else-");

    const text = `The build writes to ${unrelated}/out.log`;
    expect(await rewriteMirrorPaths(text, mirrorPath, "/repo")).toBe(text);
  });

  it("returns the input untouched when there is nothing to rewrite against", async () => {
    expect(await rewriteMirrorPaths("", "/tmp/mirror", "/repo")).toBe("");
    expect(await rewriteMirrorPaths("text", "", "/repo")).toBe("text");
  });

  it.skipIf(process.platform !== "darwin")(
    "also rewrites the /private realpath spelling macOS hands back",
    async () => {
      const mirrorPath = await makeTempDir("agy-review-");
      const resolved = await realpath(mirrorPath);

      // On macOS mkdtemp yields /var/folders/... while realpath yields
      // /private/var/folders/..., and agy reports the resolved form. A rewrite that
      // only knew the unresolved spelling would leave dead paths in every finding.
      expect(resolved).not.toBe(mirrorPath);
      expect(resolved.startsWith("/private/")).toBe(true);

      const rewritten = await rewriteMirrorPaths(`see ${resolved}/src/a.ts`, mirrorPath, "/repo");

      // The security-relevant half holds: neither spelling of the disposable copy's
      // path survives into the text handed back to the caller.
      expect(rewritten).not.toContain(mirrorPath);
      expect(rewritten).not.toContain(resolved);

      // And it lands on the repository root itself, not on "/private" + the root.
      // The unresolved spelling is a strict PREFIX of the resolved one on macOS, so
      // replacing the short variant first would corrupt every path agy actually
      // reports. `rewriteMirrorPaths` sorts its variants longest-first for exactly
      // this reason, and this assertion is what holds that ordering in place.
      expect(rewritten).toBe("see /repo/src/a.ts");
    }
  );
});

import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { mirrorFailed } from "./boundary.js";

const execFileAsync = promisify(execFile);

/**
 * Why this file exists
 * ====================
 * Measured agy 1.1.18 `request-review` can allow ordinary reads while denying
 * writes, so the mirror is not compensating for missing read/write separation.
 * The agy 1.1.18 E1 measurement instead found that any denial terminates the run
 * without an answer, that agy chooses what to deny (including reading `.env`), and
 * that all three runs failed even under an explicit no-shell prompt.
 *
 * The plugin therefore skips agy 1.1.18's permission prompts inside a throwaway
 * copy, avoiding a request-review denial that could erase partial work. `--add-dir`
 * points at that copy and the real repository path is never disclosed. The
 * guarantee is about the filesystem path the plugin hands over, rather than a
 * promise about agy 1.1.18's permission decisions.
 *
 * What this does NOT guarantee: agy 1.1.18 is still running with a blanket
 * permission flag, and the agy 1.1.16 probes observed writes to
 * `~/.gemini/antigravity-cli/`. The isolation protects the repository, not the
 * whole filesystem, and the tool descriptions say so plainly.
 *
 * Deliberately a copy and not `git worktree add`:
 *   - `git worktree add` writes into the user's own .git directory
 *     (.git/worktrees/<name>) and leaves it there if the run crashes, which makes
 *     "the repository is untouched" false in a way that is hard to state honestly.
 *   - A worktree checks out committed HEAD, so the uncommitted work that is usually
 *     the point of the review would be missing.
 *   - A worktree cannot be created in a repository that has no commits yet.
 * Both approaches write every file to disk, so the disk cost is comparable.
 */

const MAX_MIRROR_FILES = 20_000;
const MAX_MIRROR_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Enough for a very large monorepo's file listing without unbounded buffering. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

async function gitLines(cwd: string, args: string[]): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS
    });
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The file set the mirror reproduces: everything git considers part of the working
 * tree, in its *working-tree* state (not HEAD's), plus untracked files that are not
 * ignored.
 *
 * Ignored files are excluded on purpose -- they are build output, dependencies and
 * secrets, and copying them is the expensive and dangerous half of a naive `cp -R`.
 * That exclusion is a real limitation for a reviewer that wants to resolve imports
 * into `node_modules`, and it is stated in the review tool description rather than
 * hidden here.
 */
export async function listMirrorFiles(repoRoot: string): Promise<string[] | null> {
  const tracked = await gitLines(repoRoot, ["ls-files", "-z", "--cached"]);
  if (tracked === null) return null;
  const untracked = (await gitLines(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"])) ?? [];
  const deleted = new Set((await gitLines(repoRoot, ["ls-files", "-z", "--deleted"])) ?? []);
  // A file staged-as-deleted is absent from the working tree; copying it back would
  // show the reviewer a file the author has removed.
  return [...new Set([...tracked, ...untracked].filter((path) => !deleted.has(path)))];
}

function safeJoin(root: string, relativePath: string): string | null {
  const target = resolve(root, relativePath);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  // git should never hand back a path that escapes the repository, but the mirror
  // writes files, so this is checked rather than assumed.
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}

export type MirrorSkip = { path: string; reason: string };

export type ReadOnlyMirror = {
  path: string;
  fileCount: number;
  byteCount: number;
  /** Every file that did not make it in, and why. */
  skipped: MirrorSkip[];
  /** True when anything was skipped, so a review can say what it could not see. */
  degraded: boolean;
  cleanup: () => Promise<void>;
};

/**
 * Build a throwaway copy of `repoRoot`'s working tree.
 *
 * Throws a typed `mirror_failed` refusal when the directory is not a git
 * repository. There is deliberately no fallback that copies an arbitrary directory
 * tree: without git's file list there is no way to exclude ignored paths, and a
 * read-only review is not worth copying a user's `node_modules` and `.env` into the
 * system temp directory.
 */
export async function createReadOnlyMirror(
  repoRoot: string,
  options: { tmpRoot?: string } = {}
): Promise<ReadOnlyMirror> {
  const files = await listMirrorFiles(repoRoot);
  if (files === null) {
    throw mirrorFailed(
      `${repoRoot} is not a git repository (or git is unavailable), and the copy is built from git's own file list`,
      { repoRoot }
    );
  }

  const mirrorPath = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "agy-review-"));
  const skipped: MirrorSkip[] = [];

  // APFS is case-insensitive by default. Two tracked files differing only in case
  // collapse onto one another during the copy -- silently, with no error -- so the
  // reviewer would see one file where the repository has two. Detected up front so
  // it can be reported rather than discovered inside a wrong finding.
  const byLowerCase = new Map<string, string>();
  const caseCollisions = new Set<string>();
  for (const path of files) {
    const key = path.toLowerCase();
    const existing = byLowerCase.get(key);
    if (existing !== undefined && existing !== path) {
      caseCollisions.add(path);
      caseCollisions.add(existing);
    } else {
      byLowerCase.set(key, path);
    }
  }

  let fileCount = 0;
  let byteCount = 0;

  for (const path of files) {
    if (fileCount >= MAX_MIRROR_FILES || byteCount >= MAX_MIRROR_BYTES) {
      skipped.push({ path, reason: "mirror-limit" });
      continue;
    }
    if (caseCollisions.has(path)) {
      skipped.push({ path, reason: "case-collision" });
      continue;
    }
    const source = safeJoin(repoRoot, path);
    const target = safeJoin(mirrorPath, path);
    if (!source || !target) {
      skipped.push({ path, reason: "path-escape" });
      continue;
    }

    let stats;
    try {
      // lstat, not stat: a symlink is examined as a symlink so one pointing outside
      // the tree cannot silently pull in whatever it targets.
      stats = await lstat(source);
    } catch {
      skipped.push({ path, reason: "unreadable" });
      continue;
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      if (stats.isSymbolicLink()) {
        const linkTarget = await readlink(source);
        // A symlink reproduced verbatim keeps pointing at whatever it pointed at.
        // An absolute link, or a relative one that climbs out of the tree, is a
        // writable door straight back into the real repository -- the run would be
        // isolated by path and not at all in practice. These are dropped, loudly.
        const resolved = resolve(dirname(source), linkTarget);
        const rootWithSep = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
        if (isAbsolute(linkTarget) || !resolved.startsWith(rootWithSep)) {
          skipped.push({ path, reason: "symlink-escapes-tree" });
          continue;
        }
        await symlink(linkTarget, target);
        fileCount += 1;
        continue;
      }
      if (!stats.isFile()) {
        // Submodule roots arrive as directories here. Their contents are a separate
        // repository and are not mirrored.
        skipped.push({ path, reason: "not-a-regular-file" });
        continue;
      }
      if (stats.size > MAX_FILE_BYTES) {
        skipped.push({ path, reason: "file-too-large" });
        continue;
      }
      await copyFile(source, target);
      // The executable bit survives, because whether a script is executable is
      // sometimes the thing under review.
      await chmod(target, stats.mode & 0o777);
      fileCount += 1;
      byteCount += stats.size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      skipped.push({ path, reason: `copy-failed: ${code}` });
    }
  }

  return {
    path: mirrorPath,
    fileCount,
    byteCount,
    skipped,
    degraded: skipped.length > 0,
    async cleanup() {
      // A mirror left in the OS temp directory is litter, not a failure of the
      // review; never let cleanup mask a real result.
      await rm(mirrorPath, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export type TreeFingerprint = { head: string | null; status: string };

/**
 * Fingerprint the REAL repository so a read-only run can be checked afterwards.
 *
 * The real path is never handed to agy, so these two readings must match. This is
 * defence in depth: if they ever differ, the isolation argument is wrong and the
 * user needs to be told loudly rather than handed a clean-looking verdict.
 */
export async function fingerprintTree(repoRoot: string): Promise<TreeFingerprint | null> {
  const status = await gitLines(repoRoot, ["status", "--porcelain", "-z"]);
  if (status === null) return null;
  let head: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS
    });
    head = stdout.trim();
  } catch {
    // A repository with no commits has no HEAD. Not an error.
    head = null;
  }
  return { head, status: [...status].sort().join("\n") };
}

export type IsolationWarning = { class: string; message: string; files?: Record<string, string[]> };

export function compareFingerprints(
  before: TreeFingerprint | null,
  after: TreeFingerprint | null
): IsolationWarning | null {
  if (!before || !after) return null;
  if (before.head === after.head && before.status === after.status) return null;
  return {
    class: "tree_changed_during_readonly_run",
    message:
      "tree_changed_during_readonly_run: the working tree or HEAD of the real repository changed while a read-only " +
      "review was running. The review was given a throwaway copy and was never told this repository's path, so it " +
      "should not have been able to do this -- either something else changed the tree concurrently, or the isolation " +
      "this plugin relies on does not hold. Treat the verdict with suspicion and check `git status` yourself."
  };
}

/**
 * Rewrite mirror paths in rendered output back to the real repository.
 *
 * Findings cite the paths the reviewer saw, which are inside the throwaway copy --
 * paths the user cannot open and that vanish when the run ends. Only the mirror
 * prefix is rewritten, and only where it appears literally, so a finding that
 * legitimately discusses a temp directory of its own is left alone.
 */
export async function rewriteMirrorPaths(
  text: string,
  mirrorPath: string,
  repoRoot: string
): Promise<string> {
  if (!text || !mirrorPath) return text;
  const variants = [mirrorPath];
  // macOS hands out /var/folders/... which resolves through the /private symlink;
  // agy reports the resolved form, so both spellings must be rewritten.
  const real = await realpath(mirrorPath).catch(() => null);
  if (real && real !== mirrorPath) variants.push(real);
  // Longest first, and this ordering is load-bearing. On macOS the unresolved
  // spelling is a PREFIX of the resolved one, so replacing it first turns
  // /private/var/folders/.../mirror/src/a.ts into /private<repoRoot>/src/a.ts --
  // every path a read-only review cites would come back pointing nowhere.
  variants.sort((a, b) => b.length - a.length);
  let out = text;
  for (const variant of variants) out = out.split(variant).join(repoRoot);
  return out;
}

/**
 * Record what the mirror held, so writes made during a read-only run can be named
 * afterwards. Cheap: one lstat per file, no content hashing.
 */
export async function snapshotMirror(mirrorPath: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const stats = await lstat(full);
        seen.set(relative(mirrorPath, full), `${stats.size}:${stats.mtimeMs}`);
      } catch {
        // A file that vanished mid-walk is itself a change; the comparison below
        // reports it as removed.
      }
    }
  };
  await walk(mirrorPath);
  return seen;
}

function nameSome(paths: string[]): string {
  const head = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${head} +${paths.length - 5} more` : head;
}

/**
 * Name the files a read-only run created, changed or deleted inside the copy.
 * Returns null when the run left the copy exactly as it found it.
 */
export function diffMirrorSnapshots(
  before: Map<string, string> | null,
  after: Map<string, string> | null
): IsolationWarning | null {
  if (!before || !after) return null;
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, stamp] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== stamp) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path);
  }
  if (!added.length && !changed.length && !removed.length) return null;

  const parts: string[] = [];
  if (changed.length) parts.push(`modified ${nameSome(changed)}`);
  if (added.length) parts.push(`created ${nameSome(added)}`);
  if (removed.length) parts.push(`deleted ${nameSome(removed)}`);
  return {
    class: "readonly_run_wrote_files",
    files: { added, changed, removed },
    message:
      `readonly_run_wrote_files: this read-only run ${parts.join("; ")} -- inside the disposable copy, which has now ` +
      "been deleted. Your repository was never given to it and is unchanged, so none of those edits exist. If the " +
      "answer reads as though files were fixed, they were not. Re-run it with agy_run to apply the change for real."
  };
}

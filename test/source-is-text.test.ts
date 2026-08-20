import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No tracked source file may contain a NUL byte.
 *
 * A sibling plugin in this family used a literal U+0000 as a cache-key separator.
 * Git then classified the file as binary, and diff, blame, patch and
 * `git diff --check` all went blind on it -- a change nobody could review.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const SCANNED_DIRS = [
  "plugins/agy-plugin-codex/src",
  "plugins/agy-plugin-codex/skills",
  "plugins/agy-plugin-codex/.codex-plugin",
  "test",
  "scripts",
  "docs",
  ".github",
  ".agents"
];

const SCANNED_ROOT_FILES = [
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "README.md",
  "CHANGELOG.md",
  "NOTICE",
  "plugins/agy-plugin-codex/.mcp.json"
];

const EXTENSIONS = new Set([".ts", ".mjs", ".js", ".json", ".md", ".yml", ".yaml", ".txt", ".jsonl"]);

function walk(dir: string, found: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, found);
      continue;
    }
    const dot = entry.name.lastIndexOf(".");
    if (dot === -1 || !EXTENSIONS.has(entry.name.slice(dot))) continue;
    found.push(full);
  }
  return found;
}

const files = [
  ...SCANNED_DIRS.flatMap((dir) => walk(join(repoRoot, dir))),
  ...SCANNED_ROOT_FILES.map((name) => join(repoRoot, name)).filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  })
];

describe("source files stay text", () => {
  it("scans a meaningful number of files", () => {
    // Without this, a broken walk would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(25);
    expect(files.map((path) => relative(repoRoot, path))).toContain(
      "plugins/agy-plugin-codex/src/job-store.ts"
    );
  });

  it("contains no NUL byte anywhere", () => {
    const offenders = files.filter((path) => readFileSync(path).includes(0));
    expect(offenders.map((path) => relative(repoRoot, path))).toEqual([]);
  });

  it("contains no ANSI escape byte in source or documentation", () => {
    // agy's own machine-readable output is clean ASCII, and the plugin strips escapes
    // from the one listing it republishes. A literal escape checked into source would
    // travel into a caller's transcript as if it were content.
    const offenders = files
      .filter((path) => !path.endsWith(".test.ts"))
      .filter((path) => readFileSync(path).includes(0x1b));
    expect(offenders.map((path) => relative(repoRoot, path))).toEqual([]);
  });
});

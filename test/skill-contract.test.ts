import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The bidirectional docs-to-code drift gate.
 *
 * The vendored Skill is the only description of this plugin that ships inside the
 * plugin, so it is the one document that cannot be allowed to go stale. Both
 * directions are checked: an identifier the docs name must exist in the source, and
 * a failure code the source can emit must appear in the routing table.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = join(repoRoot, "plugins/agy-plugin-codex/src");
const SKILL_DIR = join(repoRoot, "plugins/agy-plugin-codex/skills/agy");

const sourceFiles = readdirSync(SRC_DIR).filter((name) => name.endsWith(".ts"));
const sourceText = sourceFiles.map((name) => readFileSync(join(SRC_DIR, name), "utf8")).join("\n");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const routing = readFileSync(join(SKILL_DIR, "references/failure-routing.md"), "utf8");

/**
 * Words that read like identifiers but name nothing in the source: product names,
 * commands, filenames, and English that happens to be backticked.
 */
const PROSE_TOKENS = new Set([
  "agy",
  "codex",
  "antigravity",
  "npm",
  "node",
  "git",
  "brew",
  "install",
  "cask",
  "true",
  "false",
  "null",
  "undefined",
  "string",
  "boolean",
  "number",
  "array",
  "object",
  "status",
  "SKILL.md",
  "AGENTS.md",
  "CLAUDE.md",
  "env",
  "file",
  "https",
  "http",
  "gemini",
  "flash",
  "claude",
  "sonnet",
  "thinking",
  "medium",
  "install-slack-app",
  "package.json",
  "plugin.json",
  "node_modules",
  "porcelain",
  "conversations",
  "brain",
  "scratch",
  "settings.json",
  "antigravity-cli",
  "gemini-3.7-flash-low",
  "claude-sonnet-4-6"
]);

function backtickedTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = match[1].trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(raw)) continue;
    for (const part of raw.split(".")) {
      if (part.length >= 4 && !PROSE_TOKENS.has(part)) tokens.add(part);
    }
  }
  return [...tokens];
}

describe("skill contract: documentation names things that exist", () => {
  it("ships the failure routing reference inside the plugin", () => {
    // Vendored deliberately: a routing table kept in the repository README can be a
    // release behind the plugin a user actually installed.
    expect(routing.length).toBeGreaterThan(1_000);
    expect(readdirSync(join(SKILL_DIR, "references"))).toContain("failure-routing.md");
  });

  it("declares the frontmatter the plugin loader requires", () => {
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: agy");
    expect(skill).toMatch(/^description: .+/m);
  });

  for (const [label, text] of [
    ["SKILL.md", skill],
    ["failure-routing.md", routing]
  ] as const) {
    it(`only names identifiers that exist in the source (${label})`, () => {
      const missing = backtickedTokens(text).filter((token) => !sourceText.includes(token));
      expect(missing, `${label} names identifiers absent from src/: ${missing.join(", ")}`).toEqual([]);
    });
  }
});

describe("skill contract: the source emits nothing the routing table omits", () => {
  const PATTERNS = [
    { label: "errorClass", pattern: /errorClass\s*[:=]\s*"([a-z][a-z_]*)"/g },
    { label: "error.code", pattern: /\bcode:\s*"([a-z][a-z_]*)"/g },
    { label: "BoundaryError", pattern: /new BoundaryError\(\s*"([a-z][a-z_]*)"/g },
    { label: "classifier", pattern: /return "([a-z][a-z_]*)";/g }
  ];

  it("lists every code the source can produce", () => {
    const found = new Map<string, string>();
    for (const name of sourceFiles) {
      const text = readFileSync(join(SRC_DIR, name), "utf8");
      for (const { label, pattern } of PATTERNS) {
        for (const match of text.matchAll(pattern)) found.set(match[1], `${name} (${label})`);
      }
      const unionBody = /export type BoundaryErrorCode =([\s\S]*?);/.exec(text)?.[1];
      if (unionBody) {
        for (const match of unionBody.matchAll(/"([a-z][a-z_]*)"/g)) {
          found.set(match[1], `${name} (BoundaryErrorCode)`);
        }
      }
    }

    // A self-check: if the scan silently stops matching, the assertion below would
    // pass vacuously and the gate would be gone.
    expect(found.size).toBeGreaterThan(20);

    const missing = [...found.entries()]
      .filter(([code]) => !routing.includes(`\`${code}\``))
      .map(([code, where]) => `${where} can return \`${code}\`, which failure-routing.md does not list`);
    expect(missing).toEqual([]);
  });

  it("documents each boundary code and each job failure class explicitly", () => {
    const BOUNDARY_CODES = [
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
    const FAILURE_CLASSES = [
      "timeout",
      "stalled",
      "terminated",
      "permission_denied",
      "auth_required",
      "quota_exhausted",
      "model_unauthorized",
      "rate_limited",
      "network_error",
      "provider_error",
      "agy_failed",
      "unknown",
      "spawn_error",
      "worker_error",
      "worker_unavailable",
      "cancelled"
    ];
    for (const code of [...BOUNDARY_CODES, ...FAILURE_CLASSES]) {
      expect(routing, `failure-routing.md omits \`${code}\``).toContain(`\`${code}\``);
    }
  });
});

describe("skill contract: the agy-specific facts are stated, not implied", () => {
  const DOCS = [
    ["SKILL.md", skill],
    ["failure-routing.md", routing]
  ] as const;

  it("tells the reader that agy cannot see a directory it was not given", () => {
    expect(skill).toMatch(/ignores the process working directory/i);
    expect(skill).toContain("antigravity-cli");
  });

  it("tells the reader that agy cannot read without also being able to write", () => {
    expect(skill).toMatch(/cannot read without also being able to write/i);
  });

  it("tells the reader that the exit code is not the verdict", () => {
    expect(skill).toMatch(/independently of its exit code/i);
  });

  it("warns that an unknown conversation id starts a fresh conversation", () => {
    for (const [label, text] of DOCS) {
      expect(text, `${label} omits the conversation_not_found warning`).toContain(
        "conversation_not_found"
      );
    }
  });

  it("never claims the read-only review protects more than the repository", () => {
    // The isolation is a filesystem guarantee about the repository only: agy still
    // writes to its own state directory on every run, and overclaiming here is the
    // one documentation error that could actually cost a user data.
    expect(skill).toMatch(/protects the repository, not the whole filesystem/i);
    expect(skill).not.toMatch(/cannot write anywhere|fully sandboxed|completely isolated/i);
  });

  it("publishes no per-kind latency figure it has not measured", () => {
    // Ported plugins in this family carry the previous CLI's measured medians. Those
    // are fabricated measurements here and must never reappear.
    for (const [label, text] of DOCS) {
      expect(text, `${label} restates a per-kind wall-time figure`).not.toMatch(
        /median\)?:?\s*(continue|run|review|adversarial_review)\s*~\s*\d+s/i
      );
    }
  });
});

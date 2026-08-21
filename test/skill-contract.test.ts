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

describe("skill contract: the docs route onto codes the runtime can actually emit", () => {
  /**
   * `workspace_required` shipped as a routing recommendation while every reachable
   * path refused with `workspace_unavailable`. The mechanical completeness gate
   * could not see it — both are members of the same union, so both appeared in both
   * places — and neither can a static reachability rule: `buildAgyArgs` really does
   * `throw new BoundaryError("workspace_required")`, it is just called with a
   * constant that is never empty.
   *
   * So this is not a general gate, and pretending otherwise with a rule that cannot
   * fail would be worse than nothing. It is a pin on the one fact that was wrong:
   * the table must keep telling callers not to route on it, and the Skill must keep
   * naming the code the runtime actually emits.
   */
  it("keeps workspace_required marked Reserved rather than recommended", () => {
    const row = routing.split("\n").find((line) => line.includes("`workspace_required`"));
    expect(row, "failure-routing.md no longer has a workspace_required row").toBeDefined();
    expect(row!).toMatch(/Reserved/i);
    expect(row!).toMatch(/workspace_unavailable/);
  });

  it("points the no-workspace case at workspace_unavailable, which is what is thrown", () => {
    const tools = readFileSync(join(SRC_DIR, "tools.ts"), "utf8");
    // The only refusal a caller with no roots can reach.
    expect(tools).toMatch(/if \(!workspaceRoots\.length\) \{[\s\S]{0,200}?workspaceUnavailable\(/);
    expect(tools).not.toMatch(/workspaceRequired\(/);

    const claim = skill.split("\n").find((line) => line.includes("no resolvable workspace is refused"));
    expect(claim, "SKILL.md no longer states which code a missing workspace produces").toBeDefined();
    expect(claim!).toContain("workspace_unavailable");
  });
});

describe("nothing claims agy is confined to the workspace it is given", () => {
  /**
   * The highest-stakes sentence in this repository. agy runs with its permission
   * prompts skipped and is NOT sandboxed to `--add-dir`; it is only ever *told*
   * about that directory. The mirror drops escaping symlinks precisely because agy
   * would follow them, so any text claiming confinement contradicts the code next to
   * it. This shipped in docs/privacy.md and in three `src/` strings at once.
   */
  const CONFINEMENT_CLAIM =
    /(can|could)\s+(only\s+)?(read|write|see|access)[^.\n]{0,60}\b(inside|within)\b|cannot\s+(read|write|see|access)[^.\n]{0,30}\boutside\b|(unreachable|inaccessible)\s+regardless|\bis\s+sandboxed\s+to\b|fully\s+sandboxed|completely\s+isolated/i;

  const SURFACES: Array<readonly [string, string]> = [
    ["SKILL.md", skill],
    ["failure-routing.md", routing],
    ["src/", sourceText],
    ...["README.md", "CHANGELOG.md", "docs/privacy.md", "docs/terms.md", "docs/development.md"].map(
      (name) => [name, readFileSync(join(repoRoot, name), "utf8")] as const
    )
  ];

  for (const [label, text] of SURFACES) {
    it(`does not overclaim confinement in ${label}`, () => {
      // Split on sentence boundaries, not lines: the sentence that overclaims and the
      // sentence that disclaims often sit on the same line, and a line-level
      // exclusion lets the violation exempt itself. That is exactly how the first
      // version of this gate passed against the very text it was written to reject.
      const offending = text
        .split(/(?<=[.!?])\s+|\n/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => CONFINEMENT_CLAIM.test(sentence))
        // A sentence that says agy is NOT confined is the thing being protected.
        .filter((sentence) => !/\bnot\b[^.]{0,40}\b(confined|sandbox)/i.test(sentence));
      expect(
        offending,
        `${label} claims agy is confined to its workspace; it is only told about it`
      ).toEqual([]);
    });
  }
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

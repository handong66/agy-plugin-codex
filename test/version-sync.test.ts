import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM helper shared with scripts/validate-plugin.mjs
import { releaseVersionIssues } from "../scripts/lib/release-version.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
};
const pluginJson = JSON.parse(
  readFileSync(join(repoRoot, "plugins/agy-plugin-codex/.codex-plugin/plugin.json"), "utf8")
) as { version: string };
const serverSource = readFileSync(join(repoRoot, "plugins/agy-plugin-codex/src/server.ts"), "utf8");
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");

/**
 * Read the version out of the source text rather than importing the module: server.ts
 * connects a stdio transport at import time, so importing it here would hang the run.
 */
function serverInfoVersion(): string {
  const match = /name:\s*"agy-plugin-codex",[\s\S]{0,600}?version:\s*"([^"]+)"/.exec(serverSource);
  if (!match) throw new Error("could not find the McpServer serverInfo version in src/server.ts");
  return match[1];
}

describe("version sync", () => {
  it("keeps package.json on plain semver", () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps the plugin manifest's release core equal to package.json", () => {
    const [releaseCore, cachebuster] = pluginJson.version.split("+");
    expect(releaseCore).toBe(packageJson.version);
    // A local cachebuster is how an installed plugin cache is forced to pick up a
    // rebuild during development. It is allowed here and refused on a release commit.
    if (cachebuster !== undefined) expect(cachebuster).toMatch(/^codex\.\d{8,}$/);
  });

  it("advertises that same version on the wire", () => {
    // This string is what a caller sees in serverInfo, so a drift here is a drift in
    // the only version anything outside this repository can observe.
    expect(serverInfoVersion()).toBe(packageJson.version);
  });
});

describe("release version gate", () => {
  it("tolerates a cachebuster during development, with a warning", () => {
    const { errors, warnings } = releaseVersionIssues({
      manifestVersion: "0.1.0+codex.20260820010203",
      packageVersion: "0.1.0",
      releaseTags: [],
      releaseEnv: undefined
    });
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toContain("drop it before cutting a release tag");
  });

  it("refuses a cachebuster on a commit a tag points at", () => {
    const { errors } = releaseVersionIssues({
      manifestVersion: "0.1.0+codex.20260820010203",
      packageVersion: "0.1.0",
      releaseTags: ["v0.1.0"],
      releaseEnv: undefined
    });
    expect(errors.join(" ")).toContain("must not carry the local cachebuster");
  });

  it("refuses a cachebuster under an explicit release environment", () => {
    const { errors } = releaseVersionIssues({
      manifestVersion: "0.1.0+codex.20260820010203",
      packageVersion: "0.1.0",
      releaseTags: [],
      releaseEnv: "1"
    });
    expect(errors.join(" ")).toContain("must not carry the local cachebuster");
  });

  it("refuses a manifest that advertises a release the built code is not", () => {
    const { errors } = releaseVersionIssues({
      manifestVersion: "0.2.0",
      packageVersion: "0.1.0",
      releaseTags: [],
      releaseEnv: undefined
    });
    expect(errors.join(" ")).toContain("advertises release 0.2.0");
  });

  it("refuses a version that is not semver at all", () => {
    const { errors } = releaseVersionIssues({
      manifestVersion: "latest",
      packageVersion: "0.1.0"
    });
    expect(errors.join(" ")).toContain("must be semver");
  });
});

describe("changelog release heading", () => {
  it("opens with a released version, not an Unreleased section", () => {
    const firstHeading = changelog.split(/\r?\n/).find((line) => line.startsWith("## "));
    expect(firstHeading).toBeDefined();
    // The em dash is part of the required format; a stray hyphen here has shipped
    // before in this plugin family and is invisible in review.
    expect(firstHeading).toMatch(/^##\s+\d+\.\d+\.\d+\s+—\s+\d{4}-\d{2}-\d{2}$/);
    expect(firstHeading).toContain(packageJson.version);
  });
});

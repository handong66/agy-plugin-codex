#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersionIssues } from "./lib/release-version.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = join(repoRoot, "plugins", "agy-plugin-codex");
const errors = [];

function requireFile(path, hint) {
  if (!existsSync(path)) errors.push(`missing ${path}${hint ? ` (${hint})` : ""}`);
}

requireFile(join(pluginRoot, ".codex-plugin", "plugin.json"));
requireFile(join(pluginRoot, ".mcp.json"));
requireFile(join(pluginRoot, "skills", "agy", "SKILL.md"));
requireFile(join(pluginRoot, "skills", "agy", "references", "failure-routing.md"));
requireFile(join(pluginRoot, "dist", "server.js"), "run npm run build");
requireFile(join(pluginRoot, "dist", "job-worker.js"), "run npm run build");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`could not read ${path}: ${error.message}`);
    return null;
  }
}

function tagsPointingAtHead() {
  try {
    // stdio silences git's own stderr: a repository with no commits yet has no HEAD,
    // which is not a validation failure and should not print an error.
    return execFileSync("git", ["tag", "--points-at", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const manifest = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
const pkg = readJson(join(repoRoot, "package.json"));

if (manifest) {
  for (const field of ["name", "version", "description", "skills", "mcpServers"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      errors.push(`plugin.json ${field} must be a non-empty string`);
    }
  }
  if (manifest.name !== "agy-plugin-codex") errors.push('plugin.json name must be "agy-plugin-codex"');
  if (manifest.skills !== "./skills/") errors.push('plugin.json skills must be "./skills/"');
  if (manifest.mcpServers !== "./.mcp.json") errors.push('plugin.json mcpServers must be "./.mcp.json"');
  if (JSON.stringify(manifest).includes("[TODO:")) errors.push("plugin.json still contains a [TODO: placeholder");

  const ui = manifest.interface ?? {};
  if (!Array.isArray(ui.defaultPrompt) || !ui.defaultPrompt.length) {
    errors.push("plugin.json interface.defaultPrompt must be a non-empty array");
  }
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    if (typeof ui[field] !== "string" || !ui[field].trim()) {
      errors.push(`plugin.json interface.${field} must be a non-empty string`);
    }
  }
  if (typeof manifest.author?.name !== "string" || !manifest.author.name.trim()) {
    errors.push("plugin.json author.name must be a non-empty string");
  }

  if (pkg) {
    const { errors: versionErrors, warnings } = releaseVersionIssues({
      manifestVersion: manifest.version,
      packageVersion: pkg.version,
      releaseTags: tagsPointingAtHead(),
      releaseEnv: process.env.AGY_PLUGIN_RELEASE
    });
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    errors.push(...versionErrors);
  }
}

const mcp = readJson(join(pluginRoot, ".mcp.json"));
if (mcp) {
  const server = mcp.mcpServers?.["agy-plugin-codex"];
  if (!server) {
    errors.push('.mcp.json must define an "agy-plugin-codex" server');
  } else {
    if (server.command !== "node") errors.push('.mcp.json command must be "node"');
    if (!Array.isArray(server.args) || !server.args.includes("./dist/server.js")) {
      errors.push('.mcp.json args must include "./dist/server.js"');
    }
    // Every environment variable the plugin actually reads has to be allowlisted, or
    // the installed plugin behaves differently from a local checkout for reasons
    // that are invisible from the code.
    for (const name of ["AGY_BIN", "AGY_WORKSPACE_ROOTS", "AGY_PLUGIN_STATE_DIR", "PATH", "HOME"]) {
      if (!server.env_vars?.includes(name)) errors.push(`.mcp.json env_vars must include "${name}"`);
    }
  }
}

const skill = existsSync(join(pluginRoot, "skills", "agy", "SKILL.md"))
  ? readFileSync(join(pluginRoot, "skills", "agy", "SKILL.md"), "utf8")
  : "";
if (skill && !skill.startsWith("---\n")) errors.push("SKILL.md must start with YAML frontmatter");
if (skill && !skill.includes("name: agy")) errors.push('SKILL.md frontmatter must declare "name: agy"');

if (errors.length) {
  console.error("Repository plugin validation failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `Repository plugin validation passed: ${repoRoot} ` +
    "(run the current plugin-creator validator as the release authority)"
);

#!/usr/bin/env node
/**
 * Assert that the agy CLI still has the flags this plugin's whole design rests on.
 *
 * Not part of `npm run check`, because it needs the real binary. Run it after an
 * `agy update`: a renamed or removed flag here does not break loudly at runtime --
 * `--add-dir` in particular fails SILENTLY, with a successful-looking run that did
 * its work inside agy's own state directory.
 */
import { spawnSync } from "node:child_process";

const bin = process.env.AGY_BIN ?? "agy";

const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
if (version.error || version.status !== 0) {
  console.error(`agy not runnable at "${bin}". Install it or set AGY_BIN. Skipping.`);
  process.exit(1);
}
console.log(`agy version: ${version.stdout.trim()}`);

const help = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 30_000 });
const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;

/** Each entry says WHY the flag matters, so a failure explains itself. */
const REQUIRED_FLAGS = [
  ["--add-dir", "the only way to set the workspace; without it agy runs in ~/.gemini/antigravity-cli"],
  ["--dangerously-skip-permissions", "without it every headless tool call is auto-denied"],
  ["--output-format", "stream-json is the only format that names the model and each tool call"],
  ["--print-timeout", "agy's own deadline, set inside the worker's budget"],
  ["--conversation", "the resume handle every timed-out job keeps"],
  ["--disable-slash-commands", "stops a prompt beginning with / being reinterpreted"],
  ["--model", "explicit model override"],
  ["--effort", "the reasoning dial"],
  ["--json-schema", "native structured output"],
  ["--mode", "accept-edits for write-capable runs"]
];

const missing = REQUIRED_FLAGS.filter(([flag]) => !text.includes(flag));
if (missing.length) {
  console.error("agy CLI contract drift -- these flags are gone or renamed:");
  for (const [flag, why] of missing) console.error(`  - ${flag}: ${why}`);
  process.exit(1);
}

const models = spawnSync(bin, ["models"], { encoding: "utf8", timeout: 60_000 });
if (models.status !== 0) {
  console.error("agy models failed, which usually means agy is not signed in.");
  process.exit(1);
}
const ids = models.stdout
  .split("\n")
  .map((line) => line.split("\t")[0]?.trim())
  .filter((id) => id && !/^Fetching/i.test(id));
if (!ids.length) {
  console.error("agy models returned no ids in the expected `id<TAB>Display Name` format.");
  process.exit(1);
}

console.log(`agy CLI contract holds: ${REQUIRED_FLAGS.length} flags present, ${ids.length} models reachable.`);

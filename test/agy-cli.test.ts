import { afterEach, describe, expect, it } from "vitest";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgyArgs,
  describeDiscoveryFailure,
  discoverAgy,
  discoveryFailure,
  expandHome,
  getAgyCandidates,
  parseAgyModels,
  promptByteLength,
  resetAgyDiscoveryCache,
  resolveEffortSelection,
  sanitizeAgyEnv,
  withPrompt,
  type DiscoverAgyResult
} from "../plugins/agy-plugin-codex/src/agy-cli.js";
import { stripAnsi } from "../plugins/agy-plugin-codex/src/ansi.js";
import { isBoundaryError } from "../plugins/agy-plugin-codex/src/boundary.js";
import { RECORDING_FAKE, withFakeAgy } from "./helpers/envelope.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

/** The value that follows a flag, or undefined when the flag is absent. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * getAgyCandidates hardcodes these two absolute paths and no environment variable
 * can mask them, so a machine with agy really installed cannot be made to see an
 * empty candidate list. Tests that need a total discovery failure say so.
 */
const UNMASKABLE_CANDIDATES = ["/opt/homebrew/bin/agy", "/usr/local/bin/agy"];

async function realAgyIsInstalled(): Promise<boolean> {
  for (const candidate of UNMASKABLE_CANDIDATES) {
    if (await isExecutable(candidate)) return true;
  }
  return false;
}

/**
 * A fake agy that fails `--version` on its first call and answers on every later
 * one, appending a byte per call to the file named by AGY_FAKE_VERSION_CALLS.
 *
 * Shell builtins only: these fakes are probed with a PATH that points at an empty
 * directory, so `wc`, `tr` and friends are not on it and a fake that shells out
 * silently takes the wrong branch.
 */
function callCountingFake(): string {
  return [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    '  if [ -f "$AGY_FAKE_VERSION_CALLS" ]; then',
    '    printf x >> "$AGY_FAKE_VERSION_CALLS"',
    '    echo "1.1.16"',
    "    exit 0",
    "  fi",
    '  printf x > "$AGY_FAKE_VERSION_CALLS"',
    '  echo "agy: cold start failed" >&2',
    "  exit 1",
    "fi",
    "exit 0",
    ""
  ].join("\n");
}

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetAgyDiscoveryCache();
  while (tempDirs.length) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("buildAgyArgs", () => {
  it("always asks for the stream format, names the workspace, and skips permission prompts", () => {
    const args = buildAgyArgs({ workspace: "/repo" });

    expect(valueOf(args, "--output-format")).toBe("stream-json");
    // --add-dir is the ONLY thing that decides what a run can see: agy ignores the
    // process working directory and otherwise operates in ~/.gemini/antigravity-cli.
    expect(valueOf(args, "--add-dir")).toBe("/repo");
    // Without this every tool call is auto-denied and the run ends ERROR having done
    // nothing; neither --sandbox nor --mode plan is a substitute.
    expect(args).toContain("--dangerously-skip-permissions");
    // A prompt may legitimately begin with a slash, which agy would otherwise
    // reinterpret as one of its own slash commands.
    expect(args).toContain("--disable-slash-commands");
  });

  it("asks for accept-edits only when the run is allowed to write", () => {
    expect(valueOf(buildAgyArgs({ workspace: "/repo" }), "--mode")).toBe("accept-edits");
    expect(valueOf(buildAgyArgs({ workspace: "/repo", readOnly: false }), "--mode")).toBe("accept-edits");
  });

  it("never puts a mode flag on a read-only run", () => {
    const args = buildAgyArgs({ workspace: "/mirror", readOnly: true });

    // Read-only is a filesystem guarantee (a throwaway copy), not a mode: --mode plan
    // would refuse reads and shell commands too, so it is deliberately absent.
    expect(args).not.toContain("--mode");
    expect(args).not.toContain("accept-edits");
    expect(args).not.toContain("plan");
  });

  it("resumes a named conversation, or continues the latest one", () => {
    expect(valueOf(buildAgyArgs({ workspace: "/repo", resumeConversationId: "abc" }), "--conversation")).toBe("abc");
    expect(buildAgyArgs({ workspace: "/repo", continueLatest: true })).toContain("--continue");
  });

  it("prefers the named conversation when both resume forms are given", () => {
    const args = buildAgyArgs({ workspace: "/repo", resumeConversationId: "abc", continueLatest: true });

    expect(valueOf(args, "--conversation")).toBe("abc");
    expect(args).not.toContain("--continue");
  });

  it("passes through model, schema file, and print timeout when they are given", () => {
    const args = buildAgyArgs({
      workspace: "/repo",
      model: "gemini-3.7-flash-low",
      jsonSchemaFile: "/tmp/schema.json",
      printTimeout: "585s"
    });

    expect(valueOf(args, "--model")).toBe("gemini-3.7-flash-low");
    expect(valueOf(args, "--json-schema")).toBe("/tmp/schema.json");
    expect(valueOf(args, "--print-timeout")).toBe("585s");
  });

  it("emits effort only for the three levels agy accepts, lowercased", () => {
    for (const level of ["low", "medium", "high"]) {
      expect(valueOf(buildAgyArgs({ workspace: "/repo", effort: level }), "--effort")).toBe(level);
    }
    expect(valueOf(buildAgyArgs({ workspace: "/repo", effort: "HIGH" }), "--effort")).toBe("high");
  });

  it("keeps an effort agy would reject off the command line entirely", () => {
    const args = buildAgyArgs({ workspace: "/repo", effort: "ultra" });

    // The caller has already been warned by resolveEffortSelection; putting the value
    // on the argv would turn an advisory into a failed run.
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("ultra");
  });

  it("refuses to build a run with no workspace instead of letting agy pick one", () => {
    let thrown: unknown;
    try {
      buildAgyArgs({ workspace: "" });
    } catch (error) {
      thrown = error;
    }

    expect(isBoundaryError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("workspace_required");
    expect((thrown as Error).message).toContain("--add-dir");
  });
});

describe("withPrompt", () => {
  it("puts the prompt at the front of the argv, where every measured invocation has it", () => {
    const args = withPrompt(buildAgyArgs({ workspace: "/repo" }), "review this");

    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("review this");
    expect(args.slice(2)).toEqual(buildAgyArgs({ workspace: "/repo" }));
  });

  it("keeps a prompt that looks like a flag as the value of -p", () => {
    const args = withPrompt([], "--not-a-flag");

    expect(args).toEqual(["-p", "--not-a-flag"]);
  });
});

describe("promptByteLength", () => {
  it("measures UTF-8 bytes, because the argv limit is a byte limit", () => {
    // A 250,000-character CJK prompt is about 750 kB: counting characters would let a
    // prompt that cannot fit in an argv past the guard.
    expect("你好".length).toBe(2);
    expect(promptByteLength("你好")).toBe(6);

    expect(promptByteLength("\u{1f680}")).toBe(4);
    expect(promptByteLength("ascii")).toBe(5);
    expect(promptByteLength("")).toBe(0);
  });
});

describe("resolveEffortSelection", () => {
  it("passes the three accepted levels through, lowercased and unwarned", () => {
    expect(resolveEffortSelection("low")).toEqual({ effort: "low", warnings: [] });
    expect(resolveEffortSelection("Medium")).toEqual({ effort: "medium", warnings: [] });
    expect(resolveEffortSelection("HIGH")).toEqual({ effort: "high", warnings: [] });
  });

  it("warns and selects nothing for a level agy does not accept", () => {
    const selection = resolveEffortSelection("ultra");

    expect(selection.effort).toBeUndefined();
    expect(selection.warnings).toHaveLength(1);
    expect(selection.warnings[0]).toContain("ultra");
    expect(selection.warnings[0]).toContain("low, medium, high");
  });

  it("says nothing at all when no effort was requested", () => {
    expect(resolveEffortSelection()).toEqual({ warnings: [] });
    expect(resolveEffortSelection("")).toEqual({ warnings: [] });
  });
});

describe("parseAgyModels", () => {
  it("reads ids from the left column and drops the progress line", () => {
    const parsed = parseAgyModels(fixture("agy-models.txt"));

    // `Fetching available models...` is a progress message, not a model.
    expect(parsed.lines.some((line) => line.startsWith("Fetching"))).toBe(false);
    expect(parsed.lines).toHaveLength(4);
    expect(parsed.ids).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-low",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium"
    ]);
  });

  it("never returns a display name as an id", () => {
    const parsed = parseAgyModels(fixture("agy-models.txt"));

    // agy's own unknown-model error lists the RIGHT column, so a caller copying a
    // name out of a failure message would get a value --model does not accept.
    expect(parsed.ids).not.toContain("Gemini 3.7 Flash (Low)");
    for (const id of parsed.ids) {
      expect(id).not.toContain(" ");
      expect(id).not.toContain("(");
    }
  });

  it("returns nothing for an empty listing", () => {
    expect(parseAgyModels("")).toEqual({ ids: [], lines: [] });
    expect(parseAgyModels("Fetching available models...\n").ids).toEqual([]);
  });
});

describe("sanitizeAgyEnv", () => {
  it("strips every CODEX_ variable and keeps the rest", () => {
    const sanitized = sanitizeAgyEnv({
      CODEX_HOME: "/codex/home",
      CODEX_SANDBOX: "read-only",
      CODEX_: "edge",
      PATH: "/usr/bin",
      AGY_BIN: "/opt/homebrew/bin/agy",
      HOME: "/home/x"
    });

    // agy is a separate agent with its own account and state directory; inheriting
    // CODEX_* would hand it Codex-private context it has no reason to see.
    expect(Object.keys(sanitized).filter((name) => name.startsWith("CODEX_"))).toEqual([]);
    expect(sanitized).toEqual({ PATH: "/usr/bin", AGY_BIN: "/opt/homebrew/bin/agy", HOME: "/home/x" });
  });

  it("drops keys whose value is undefined so spawn does not see them", () => {
    expect(sanitizeAgyEnv({ KEPT: "1", DROPPED: undefined })).toEqual({ KEPT: "1" });
  });
});

describe("expandHome", () => {
  it("expands a bare tilde and a tilde path, and leaves an absolute path alone", () => {
    expect(expandHome("~", "/home/x")).toBe("/home/x");
    expect(expandHome("~/bin/agy", "/home/x")).toBe("/home/x/bin/agy");
    expect(expandHome("/opt/homebrew/bin/agy", "/home/x")).toBe("/opt/homebrew/bin/agy");
  });
});

describe("getAgyCandidates", () => {
  it("tries an explicitly configured binary before anything else", () => {
    const candidates = getAgyCandidates({
      agyBin: "~/explicit/agy",
      homeDir: "/home/x",
      env: { AGY_BIN: "/from/env/agy", PATH: "/pdir" }
    });

    expect(candidates[0]).toBe("/home/x/explicit/agy");
    expect(candidates).toContain("/from/env/agy");
    expect(candidates).toContain("/home/x/.local/bin/agy");
    expect(candidates).toContain("/pdir/agy");
  });

  it("lists each candidate once", () => {
    const candidates = getAgyCandidates({
      agyBin: "/opt/homebrew/bin/agy",
      homeDir: "/home/x",
      env: { AGY_BIN: "/opt/homebrew/bin/agy", PATH: "/opt/homebrew/bin" }
    });

    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("discoverAgy", () => {
  it("finds the configured binary and reads its version", async () => {
    await withFakeAgy(RECORDING_FAKE, async (bin) => {
      const discovered = await discoverAgy();

      expect(discovered.ok).toBe(true);
      expect(discovered.bin).toBe(bin);
      expect(discovered.version).toBe("1.1.16");
      // AGY_BIN is a decision, not a suggestion: it is trusted once it is executable.
      expect(discovered.source).toBe("explicit");
    });
  });

  it("remembers the answer for the life of the process", async () => {
    await withFakeAgy(RECORDING_FAKE, async (bin) => {
      expect((await discoverAgy()).source).toBe("explicit");

      // Without the memo every call re-walks the candidate list with a spawn per
      // entry, which is how a check can report the CLI available and the very next
      // run report it missing.
      const second = await discoverAgy();
      expect(second.source).toBe("cache");
      expect(second.bin).toBe(bin);
      expect(second.version).toBe("1.1.16");
    });
  });

  it("re-probes after the cache is reset and when force is asked for", async () => {
    await withFakeAgy(RECORDING_FAKE, async () => {
      await discoverAgy();
      expect((await discoverAgy()).source).toBe("cache");

      resetAgyDiscoveryCache();
      expect((await discoverAgy()).source).toBe("explicit");

      expect((await discoverAgy()).source).toBe("cache");
      expect((await discoverAgy({ force: true })).source).toBe("explicit");
    });
  });

  it("does not freeze a failed version probe into the memo", async () => {
    const dir = await tempDir("agy-probe-count-");
    const home = join(dir, "home");
    const emptyPath = join(dir, "empty-path");
    await mkdir(home, { recursive: true });
    await mkdir(emptyPath, { recursive: true });
    const counter = join(dir, "version-calls");
    const bin = join(dir, "agy");
    // One byte per --version call, so the test can prove the probe ran again rather
    // than replaying a remembered answer. The first call fails the way a cold binary
    // can; every later call succeeds.
    await writeFile(bin, callCountingFake());
    await chmod(bin, 0o755);

    const options = {
      env: { AGY_BIN: bin, AGY_FAKE_VERSION_CALLS: counter, PATH: emptyPath, HOME: home },
      homeDir: home
    };

    const first = await discoverAgy(options);
    // An explicitly configured binary is trusted once it is executable, so a failed
    // --version leaves the discovery usable but versionless.
    expect(first.ok).toBe(true);
    expect(first.bin).toBe(bin);
    expect(first.version).toBeUndefined();
    expect(first.errors.join(" ")).toContain("--version exited 1");

    // The versionless answer is NOT remembered. Memoising it would make agy_check
    // report a blank version for the whole process even though the CLI answers a
    // moment later, so the next call re-probes and picks the version up.
    const second = await discoverAgy(options);
    expect(second.source).toBe("explicit");
    expect(second.version).toBe("1.1.16");
    expect(await readFile(counter, "utf8")).toBe("xx");

    // Now that a complete answer exists, it IS remembered: the counter stops moving.
    const cached = await discoverAgy(options);
    expect(cached.source).toBe("cache");
    expect(cached.version).toBe("1.1.16");
    expect(await readFile(counter, "utf8")).toBe("xx");

    const forced = await discoverAgy({ ...options, force: true });
    expect(forced.version).toBe("1.1.16");
    expect(forced.source).toBe("explicit");
    expect(await readFile(counter, "utf8")).toBe("xxx");
  });

  it("never caches a failure, so a CLI installed a moment later is still found", async () => {
    const dir = await tempDir("agy-late-install-");
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    await mkdir(home, { recursive: true });
    await mkdir(binDir, { recursive: true });
    const counter = join(dir, "version-calls");
    const bin = join(binDir, "agy");
    await writeFile(bin, callCountingFake());
    await chmod(bin, 0o755);

    const options = {
      env: { AGY_FAKE_VERSION_CALLS: counter, PATH: binDir, HOME: home },
      homeDir: home
    };

    if (await realAgyIsInstalled()) {
      // The probe loop reaches /opt/homebrew/bin/agy before any PATH entry and those
      // paths cannot be masked through the environment, so on a machine with agy
      // really installed the loop stops there and the fake is never consulted. The
      // "a failure is never cached" branch below is only reachable without one.
      const discovered = await discoverAgy(options);
      expect(discovered.ok).toBe(true);
      expect(UNMASKABLE_CANDIDATES).toContain(discovered.bin);
      return;
    }

    const first = await discoverAgy(options);
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe("cli_not_found");

    // The failure must not be remembered: the next call has to be free to find a CLI
    // that just finished installing.
    const second = await discoverAgy(options);
    expect(second.ok).toBe(true);
    expect(second.bin).toBe(bin);
    expect(second.version).toBe("1.1.16");
    expect(second.source).toBe("probe");
  });
});

describe("discovery failure", () => {
  it("names the paths it tried and how to fix it", async () => {
    const dir = await tempDir("agy-missing-");
    const home = join(dir, "home");
    const emptyPath = join(dir, "empty-path");
    await mkdir(home, { recursive: true });
    await mkdir(emptyPath, { recursive: true });
    const missing = join(dir, "no-such-agy");

    const discovered = await discoverAgy({
      env: { AGY_BIN: missing, PATH: emptyPath, HOME: home },
      homeDir: home
    });

    expect(discovered.tried[0]).toBe(missing);
    expect(discovered.errors.join(" | ")).toContain("explicitly configured");
    if (!discovered.ok) {
      // Only reachable on a machine with no agy at the unmaskable hardcoded paths.
      expect(discovered.errorCode).toBe("cli_not_found");
    }

    // The refusal is built from the real tried/errors of the probe above, so the
    // message assertions hold whether or not this machine has agy installed.
    const failed: DiscoverAgyResult = { ok: false, tried: discovered.tried, errors: discovered.errors };
    const described = describeDiscoveryFailure(failed);
    expect(described).toContain("cli_not_found");
    expect(described).toContain(missing);
    expect(described).toContain("Tried:");
    expect(described).toContain("AGY_BIN");

    const error = discoveryFailure(failed);
    expect(isBoundaryError(error)).toBe(true);
    // Nothing was executable, so retrying the identical call cannot succeed.
    expect(error.code).toBe("cli_not_found");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(described);
    expect(error.details?.tried).toEqual(discovered.tried);
  });

  it("keeps a probe timeout distinct from a missing binary", () => {
    const error = discoveryFailure({
      ok: false,
      tried: ["/opt/homebrew/bin/agy"],
      errors: ["/opt/homebrew/bin/agy: --version exited null (probe timed out): "],
      errorCode: "cli_probe_timeout"
    });

    expect(error.code).toBe("cli_probe_timeout");
    // A cold binary that answered slowly once may answer in time on the next call.
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("did not answer --version");
  });
});

describe("stripAnsi", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  it("removes CSI colour sequences", () => {
    // `agy models` draws its listing for a terminal even when stdout is a pipe, and
    // that listing is published into the caller's transcript.
    expect(stripAnsi(`${ESC}[1mGemini 3.7 Flash${ESC}[0m`)).toBe("Gemini 3.7 Flash");
    expect(stripAnsi(`${ESC}[2K${ESC}[1;31mred${ESC}[m`)).toBe("red");
  });

  it("removes OSC strings terminated by BEL or by a string terminator", () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}body`)).toBe("body");
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link`)).toBe("link");
  });

  it("leaves text with no escapes untouched", () => {
    expect(stripAnsi("gemini-3.7-flash-low\tGemini 3.7 Flash (Low)")).toBe(
      "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)"
    );
  });
});

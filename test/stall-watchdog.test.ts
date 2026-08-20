import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STALL_MAX_STDOUT_CHARS,
  STALL_TIMEOUT_MS,
  isProviderStall
} from "../plugins/agy-plugin-codex/src/job-finalize.js";

/**
 * The no-progress watchdog decides whether silence is a provider hang or slow work.
 * Getting it wrong in either direction is expensive: a false positive files a slow
 * build as a hang (with guidance saying a larger timeoutMs will not help, which is
 * exactly wrong), and a false negative spends a whole timeoutMs discovering that a
 * run that emitted nothing was never going to finish.
 */

describe("a run that has completed a tool call is working, however quiet it has gone", () => {
  it.each([
    ["one call", 1],
    ["several calls", 7]
  ])("never reports a stall after %s, at any silence and any output size", (_name, toolCalls) => {
    // A first tool call that is a build or a test run stays quiet for far longer
    // than the stall window. Killing it would file slow work as a provider hang.
    expect(isProviderStall({ silentMs: STALL_TIMEOUT_MS, stdoutChars: 0, toolCalls })).toBe(false);
    expect(isProviderStall({ silentMs: 60 * 60_000, stdoutChars: 0, toolCalls })).toBe(false);
    expect(isProviderStall({ silentMs: Number.MAX_SAFE_INTEGER, stdoutChars: 10, toolCalls })).toBe(false);
  });
});

describe("silence alone is not a stall", () => {
  it("stays quiet below the stall window", () => {
    expect(isProviderStall({ silentMs: 0, stdoutChars: 0, toolCalls: 0 })).toBe(false);
    expect(isProviderStall({ silentMs: STALL_TIMEOUT_MS - 1, stdoutChars: 0, toolCalls: 0 })).toBe(false);
  });

  it("fires exactly at the window, not one millisecond earlier", () => {
    expect(isProviderStall({ silentMs: STALL_TIMEOUT_MS - 1, stdoutChars: 100, toolCalls: 0 })).toBe(false);
    expect(isProviderStall({ silentMs: STALL_TIMEOUT_MS, stdoutChars: 100, toolCalls: 0 })).toBe(true);
  });
});

describe("a run that has produced real output is not a hang either", () => {
  it("stops reporting a stall once stdout has grown past the floor", () => {
    expect(
      isProviderStall({ silentMs: 10 * STALL_TIMEOUT_MS, stdoutChars: STALL_MAX_STDOUT_CHARS, toolCalls: 0 })
    ).toBe(false);
    expect(
      isProviderStall({
        silentMs: 10 * STALL_TIMEOUT_MS,
        stdoutChars: STALL_MAX_STDOUT_CHARS + 1_000,
        toolCalls: 0
      })
    ).toBe(false);
  });

  it("reports a stall for long silence with almost nothing written and no action taken", () => {
    expect(
      isProviderStall({ silentMs: STALL_TIMEOUT_MS + 1_000, stdoutChars: 250, toolCalls: 0 })
    ).toBe(true);
    expect(isProviderStall({ silentMs: STALL_TIMEOUT_MS, stdoutChars: 0, toolCalls: 0 })).toBe(true);
  });
});

describe("the stdout floor sits above what agy emits before doing anything", () => {
  it("is larger than a real agy init event", () => {
    const initLine = readFileSync(new URL("./fixtures/agy-run-success.jsonl", import.meta.url), "utf8")
      .split("\n")[0];

    // The init event is the first thing every agy run writes, and it enumerates the
    // tool list -- on the real CLI that is about 1.4 kB for 57 tools. If the floor
    // were below the size of `init`, a run that has emitted ONLY `init` (that is, a
    // run that has done nothing at all) could never qualify as stalled and the
    // watchdog would never fire on the case it exists for.
    expect(JSON.parse(initLine).event).toBe("init");
    expect(initLine.length).toBeLessThan(STALL_MAX_STDOUT_CHARS);

    // And such a run does still qualify, which is the property that actually matters.
    expect(
      isProviderStall({ silentMs: STALL_TIMEOUT_MS, stdoutChars: initLine.length, toolCalls: 0 })
    ).toBe(true);
  });

  it("keeps a comfortable margin over the real 57-tool init line", () => {
    // Stated as a number rather than read from the trimmed fixture, whose tool list
    // is shortened for readability.
    const REAL_INIT_LINE_CHARS = 1_400;
    expect(STALL_MAX_STDOUT_CHARS).toBeGreaterThan(REAL_INIT_LINE_CHARS * 2);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  FOREGROUND_MAX_TIMEOUT_MS,
  KIND_MEDIAN_MS,
  KIND_P90_MS,
  KIND_P90_SAMPLE_SIZE,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  TYPICAL_WALL_TIME_NOTE,
  printTimeoutFor,
  resolveTimeoutBudget,
  timeoutSchema
} from "../plugins/agy-plugin-codex/src/timeout-budget.js";

describe("timeoutSchema", () => {
  it("refuses a budget below the floor", () => {
    expect(timeoutSchema.safeParse(1_000).success).toBe(false);
    expect(timeoutSchema.safeParse(MIN_TIMEOUT_MS - 1).success).toBe(false);
    expect(timeoutSchema.safeParse(MAX_TIMEOUT_MS + 1).success).toBe(false);
  });

  it("refuses a value that is not a whole number of milliseconds", () => {
    expect(timeoutSchema.safeParse(10_000.5).success).toBe(false);
    expect(timeoutSchema.safeParse("10000").success).toBe(false);
    expect(timeoutSchema.safeParse(Number.NaN).success).toBe(false);
  });

  it("accepts the whole documented range", () => {
    expect(timeoutSchema.safeParse(10_000).success).toBe(true);
    expect(timeoutSchema.safeParse(86_400_000).success).toBe(true);
    expect(timeoutSchema.safeParse(DEFAULT_TIMEOUT_MS).success).toBe(true);
  });

  it("is optional, so a caller can leave the budget to the default", () => {
    const parsed = timeoutSchema.safeParse(undefined);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBeUndefined();
  });
});

describe("resolveTimeoutBudget", () => {
  it("clamps a foreground request to what the host will wait for, and says so", () => {
    const budget = resolveTimeoutBudget({ kind: "run", background: false, requestedTimeoutMs: 600_000 });

    // Codex aborts a tools/call at 300s, so a foreground call cannot outlive it.
    // The request is clamped rather than refused.
    expect(budget.timeoutMs).toBe(FOREGROUND_MAX_TIMEOUT_MS);
    expect(budget.warnings).toHaveLength(1);
    expect(budget.warnings[0]).toContain("600000");
    expect(budget.warnings[0]).toContain(String(FOREGROUND_MAX_TIMEOUT_MS));
    expect(budget.warnings[0]).toContain("background:true");
  });

  it("says the clamped value came from the default when the caller asked for nothing", () => {
    const budget = resolveTimeoutBudget({ kind: "run", background: false });

    expect(budget.timeoutMs).toBe(FOREGROUND_MAX_TIMEOUT_MS);
    // Otherwise the warning reads as though the caller chose 600000 themselves.
    expect(budget.warnings[0]).toContain("(the default)");
  });

  it("leaves a foreground request inside the ceiling alone", () => {
    const budget = resolveTimeoutBudget({ kind: "run", background: false, requestedTimeoutMs: 120_000 });

    expect(budget.timeoutMs).toBe(120_000);
    expect(budget.warnings).toEqual([]);
  });

  it("never clamps a background job, which the worker enforces itself", () => {
    for (const requested of [600_000, 3_600_000, MAX_TIMEOUT_MS]) {
      const budget = resolveTimeoutBudget({ kind: "review", background: true, requestedTimeoutMs: requested });

      expect(budget.timeoutMs).toBe(requested);
      expect(budget.warnings).toEqual([]);
    }
  });

  it("publishes no p90 tables, because none have been measured against agy", () => {
    // Intentional: the sibling plugins' per-kind latency tables describe a different
    // CLI talking to different providers. A ported latency figure is a fabricated
    // measurement, and it would be published on every tool description as though it
    // came from this runtime. These must stay empty until real agy jobs supply them.
    expect(KIND_P90_MS).toEqual({});
    expect(KIND_MEDIAN_MS).toEqual({});
    expect(KIND_P90_SAMPLE_SIZE).toEqual({});
  });

  it("stays silent about a tiny budget rather than warning from a table it does not have", () => {
    for (const kind of ["run", "continue", "rescue", "review", "adversarial_review"] as const) {
      const budget = resolveTimeoutBudget({ kind, background: true, requestedTimeoutMs: MIN_TIMEOUT_MS });

      expect(budget.timeoutMs).toBe(MIN_TIMEOUT_MS);
      expect(budget.warnings).toEqual([]);
    }
  });
});

describe("printTimeoutFor", () => {
  it("gives agy a deadline strictly inside the worker's budget", () => {
    // agy has to get the chance to write its own result document -- with the
    // conversation id -- before the worker SIGTERMs the process group.
    for (const budget of [MIN_TIMEOUT_MS, 60_000, FOREGROUND_MAX_TIMEOUT_MS, 600_000, MAX_TIMEOUT_MS]) {
      const printTimeout = printTimeoutFor(budget);

      expect(printTimeout).toMatch(/^\d+s$/);
      expect(Number.parseInt(printTimeout, 10) * 1_000).toBeLessThan(budget);
    }
  });

  it("never asks agy for a deadline below five seconds", () => {
    expect(printTimeoutFor(MIN_TIMEOUT_MS)).toBe("5s");
    expect(printTimeoutFor(1_000)).toBe("5s");
    expect(printTimeoutFor(0)).toBe("5s");
  });

  it("keeps the usual margin for a budget large enough to hold it", () => {
    expect(printTimeoutFor(600_000)).toBe("585s");
  });
});

describe("TYPICAL_WALL_TIME_NOTE", () => {
  it("claims no per-kind distribution, because none was measured", () => {
    expect(TYPICAL_WALL_TIME_NOTE).not.toMatch(/median.*(run|review|continue)\s*~/);
    expect(TYPICAL_WALL_TIME_NOTE).not.toMatch(/p90/i);
  });

  it("points at a signal the wire actually carries", () => {
    // lastEventAt is on the public record and is the same clock the no-progress
    // watchdog reads, so a caller can judge lateness from evidence rather than a
    // borrowed distribution.
    expect(TYPICAL_WALL_TIME_NOTE).toContain("lastEventAt");
  });
});

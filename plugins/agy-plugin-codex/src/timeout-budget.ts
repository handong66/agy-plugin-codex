import { z } from "zod";
import type { JobKind } from "./job-store.js";

/**
 * Wall-clock budget policy for agy jobs.
 *
 * The sibling plugins this project's structure comes from ship per-kind p90 and
 * median tables computed from thousands of their own recorded jobs. Those numbers
 * describe a different CLI talking to different providers and are NOT restated
 * here: a ported latency figure is a fabricated measurement, and it would be
 * published on every tool description as though it came from this runtime.
 *
 * So the tables below are empty on purpose, and `resolveTimeoutBudget` is written
 * to stay silent for a kind it has no sample for. The only agy timings measured so
 * far are floor numbers from toy prompts (docs/AGY-RUNTIME-CONTRACT.md section 9):
 * ~2-3s for a trivial prompt with no tools, ~4s for a single-file read. Those are
 * not review-sized work and are deliberately not turned into a budget.
 *
 * When enough real jobs have accumulated in the state directory, fill these in and
 * put the sample size next to each number so a later reader can tell what it is
 * worth.
 */
export const BUDGET_SAMPLE_WINDOW = "unmeasured";

/**
 * Enforced by the background worker; the record keeps the effective value.
 *
 * agy's own `--print-timeout` default is 5m0s. This is deliberately wider, because
 * a job that outlives its budget here is filed as a resumable timeout with its
 * conversation id intact, whereas agy's own timeout is just a killed process.
 */
export const DEFAULT_TIMEOUT_MS = 600_000;

export const MIN_TIMEOUT_MS = 10_000;

export const MAX_TIMEOUT_MS = 86_400_000;

/**
 * Codex aborts a `tools/call` at 300s, so a foreground call cannot outlive it.
 * Requests above this are clamped (never refused) and reported in `warnings`.
 * This is a property of the host, not of agy.
 */
export const FOREGROUND_MAX_TIMEOUT_MS = 240_000;

/**
 * agy's own deadline, handed to it as `--print-timeout`.
 *
 * Set slightly inside the worker's budget so agy gets the chance to write its own
 * result document -- with the conversation id and whatever text it has -- before
 * the worker SIGTERMs the process group and the run leaves no resume handle.
 */
export const PRINT_TIMEOUT_MARGIN_MS = 15_000;

export function printTimeoutFor(timeoutMs: number): string {
  const seconds = Math.max(Math.round((timeoutMs - PRINT_TIMEOUT_MARGIN_MS) / 1_000), 5);
  return `${seconds}s`;
}

/** p90 wall time per kind. Empty until measured against agy. */
export const KIND_P90_MS: Partial<Record<JobKind, number>> = {};

/** Median wall time per kind, for callers deciding whether a job is late. */
export const KIND_MEDIAN_MS: Partial<Record<JobKind, number>> = {};

export const KIND_P90_SAMPLE_SIZE: Partial<Record<JobKind, number>> = {};

/**
 * One sentence, published on every tool that starts or observes a job.
 *
 * It says what is actually known rather than inventing a distribution. Every signal
 * it names is one the wire can carry: `lastEventAt` is on the public record and is
 * the same clock the no-progress watchdog reads.
 */
export const TYPICAL_WALL_TIME_NOTE =
  "No per-kind wall-time distribution has been measured for agy yet, so this plugin publishes none. The only " +
  "measured figures are floors from toy prompts (about 2-3s with no tools, about 4s for a single file read), which " +
  "say nothing about review-sized work. Judge lateness from agy_status: a job whose lastEventAt is more than 45s in " +
  "the past has gone quiet; a job still emitting events is working, however long it has been running. Do not cancel " +
  "before timeoutMs on elapsed time alone -- a cancelled job loses the conversation a timed-out job keeps.";

export const timeoutSchema = z
  .number()
  .int()
  .min(MIN_TIMEOUT_MS)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(
    "Wall-clock budget in milliseconds, 10000..86400000. Default 600000. Lowering timeoutMs does not make agy " +
      "faster; it discards work, and a job that runs out of budget is filed as a resumable timeout rather than a " +
      "result. Omit this field unless the user asked for a hard deadline. Foreground calls (background:false) are " +
      "clamped to 240000 because Codex aborts a tools/call at 300s; use background:true for a real budget. " +
      TYPICAL_WALL_TIME_NOTE
  );

export type TimeoutBudget = {
  /** Budget actually handed to agy after clamping. */
  timeoutMs: number;
  /** Advisory only. A budget is never refused because of these. */
  warnings: string[];
};

/**
 * Resolve the effective budget for one call. Warnings are advisory: a low budget is
 * a prediction of a timeout, not a reason to reject the caller's request.
 */
export function resolveTimeoutBudget(params: {
  kind: JobKind;
  background: boolean;
  requestedTimeoutMs?: number;
}): TimeoutBudget {
  const warnings: string[] = [];
  const requested = params.requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timeoutMs = requested;

  if (!params.background && requested > FOREGROUND_MAX_TIMEOUT_MS) {
    timeoutMs = FOREGROUND_MAX_TIMEOUT_MS;
    const source = params.requestedTimeoutMs === undefined ? " (the default)" : "";
    warnings.push(
      `Foreground timeoutMs=${requested}${source} was clamped to ${FOREGROUND_MAX_TIMEOUT_MS} because Codex aborts a tools/call at 300s. ` +
        "Use background:true (the default for agy_run) so the worker can enforce the full budget."
    );
  }

  // Stays silent for a kind with no recorded sample, which today is every kind.
  // Warning from a table that was copied rather than measured would be worse than
  // saying nothing.
  const p90 = KIND_P90_MS[params.kind];
  const sampleSize = KIND_P90_SAMPLE_SIZE[params.kind];
  if (p90 !== undefined && timeoutMs < p90) {
    warnings.push(
      `timeoutMs=${timeoutMs} is below the p90 wall time for kind=${params.kind} (${p90}ms, n=${sampleSize}, ${BUDGET_SAMPLE_WINDOW}). ` +
        "Lowering timeoutMs does not make agy faster; it discards work. Expect this job to hit the budget before agy produces final text."
    );
  }

  return { timeoutMs, warnings };
}

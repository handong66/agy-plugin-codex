import { parseAgyModels, runAgy } from "./agy-cli.js";
import { stripAnsi } from "./ansi.js";

/**
 * `agy models` goes to Google's backend on every call and takes seconds. Nothing
 * about the answer changes under us mid-session, and `agy_check` is the call an
 * orchestrator makes at the start of every batch, so the listing is memoised for
 * the life of this MCP server process.
 *
 * There is no TTL, on purpose: the answer changes when the user signs in, signs
 * out, or their account's model access changes, none of which a timer can predict.
 * `force: true` is the escape hatch and the response says when the cached answer
 * was taken.
 */
export type ModelListing = {
  /** Model ids in agy's own spelling -- the values `--model` accepts. */
  ids: string[];
  /** Cleaned lines of the CLI's own output, id and display name together. */
  lines: string[];
  exitCode: number | null;
  raw: string;
  cachedAt: string;
};

export type CachedModels = ModelListing & { cacheHit: boolean };

const MAX_CACHE_ENTRIES = 32;
const MODELS_TIMEOUT_MS = 45_000;

const modelCache = new Map<string, ModelListing>();

/** Exposed for tests and for `agy_check`'s explicit refresh. */
export function resetCheckCache(): void {
  modelCache.clear();
}

/**
 * The model ids `agy_check` last enumerated in this process, if any.
 *
 * Used to fail an obviously wrong `--model` before a job is spent on it. Empty
 * until a check has run, and an empty list never refuses anything.
 */
export function knownModelIds(): string[] {
  const ids = new Set<string>();
  for (const listing of modelCache.values()) for (const id of listing.ids) ids.add(id);
  return [...ids];
}

export async function listModels(options: {
  agyBin?: string;
  cwd?: string;
  force?: boolean;
}): Promise<CachedModels> {
  const key = `${options.agyBin ?? ""} ${options.cwd ?? ""}`;
  if (!options.force) {
    const hit = modelCache.get(key);
    if (hit) return { ...hit, cacheHit: true };
  }

  const result = await runAgy(["models"], {
    cwd: options.cwd,
    agyBin: options.agyBin,
    timeoutMs: MODELS_TIMEOUT_MS
  });
  const raw = stripAnsi(result.stdout || result.stderr);
  const listing: ModelListing = {
    ...parseAgyModels(raw),
    exitCode: result.exitCode,
    raw,
    cachedAt: new Date().toISOString()
  };
  // Only successes are remembered. A memoised failure is not a cached answer, it is
  // a stuck one: a single transient network failure would otherwise make every
  // later check in this process report the account as unusable until it restarted.
  if (result.exitCode === 0 && listing.ids.length) {
    if (modelCache.size >= MAX_CACHE_ENTRIES) modelCache.clear();
    modelCache.set(key, listing);
  }
  return { ...listing, cacheHit: false };
}

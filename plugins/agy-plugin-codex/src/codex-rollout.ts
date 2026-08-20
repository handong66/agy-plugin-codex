import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Recover the workspace directory of the current Codex thread.
 *
 * This exists only as one link in the workspace-root discovery chain. Codex does
 * not always supply a workspace on a tool call -- a bare `codex exec` task, for
 * example, supplies neither standard MCP roots nor per-call workspace metadata --
 * and for agy that is not a degraded run but an impossible one, because agy has no
 * process-cwd fallback to land in.
 *
 * Only `session_meta.cwd` is ever read, and only from a rollout whose own payload
 * id matches the thread id, so another session's directory can never be adopted.
 * The transcript itself is deliberately not parsed: agy has no session-import
 * format, so there is nothing this plugin could do with a Codex conversation except
 * paste it into a prompt, which the caller can do more selectively.
 */

type JsonRecord = Record<string, unknown>;

export type FindCodexRolloutOptions = {
  threadId?: string;
  codexHome?: string;
};

export type CodexRolloutWorkspace = {
  rolloutFound: boolean;
  cwd: string | null;
};

/** `session_meta` is the first record in a rollout, so only the head is read. */
const SESSION_META_PREFIX_BYTES = 65_536;

export const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function walkJsonlFiles(dir: string, threadId: string, found: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkJsonlFiles(fullPath, threadId, found);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        found.push(fullPath);
      }
    })
  );

  return found;
}

export async function findCodexRolloutFile(options: FindCodexRolloutOptions = {}): Promise<string | null> {
  const threadId = options.threadId ?? process.env.CODEX_THREAD_ID;
  if (!threadId || !THREAD_ID_PATTERN.test(threadId)) return null;

  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sessionsDir = join(codexHome, "sessions");
  const files = await walkJsonlFiles(sessionsDir, threadId);
  if (!files.length) return null;

  const withStats = await Promise.all(
    files.map(async (file) => ({
      file,
      mtimeMs: await stat(file)
        .then((stats) => stats.mtimeMs)
        .catch(() => 0)
    }))
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].file;
}

export async function findCodexRolloutWorkspace(
  options: FindCodexRolloutOptions = {}
): Promise<CodexRolloutWorkspace> {
  const threadId = options.threadId ?? process.env.CODEX_THREAD_ID;
  if (!threadId || !THREAD_ID_PATTERN.test(threadId)) {
    return { rolloutFound: false, cwd: null };
  }

  const rolloutFile = await findCodexRolloutFile({ ...options, threadId });
  if (!rolloutFile) return { rolloutFound: false, cwd: null };

  const handle = await open(rolloutFile, "r").catch(() => null);
  if (!handle) return { rolloutFound: true, cwd: null };
  let jsonl = "";
  try {
    const buffer = Buffer.alloc(SESSION_META_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    jsonl = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    if (record.type !== "session_meta" || !isRecord(record.payload)) continue;
    // The id check is the security property: without it, the most recently written
    // rollout in the sessions directory could hand this run another thread's cwd.
    if (record.payload.id !== threadId) continue;
    const cwd = record.payload.cwd;
    return {
      rolloutFound: true,
      cwd: typeof cwd === "string" && cwd.length <= 4_096 ? cwd : null
    };
  }

  return { rolloutFound: true, cwd: null };
}

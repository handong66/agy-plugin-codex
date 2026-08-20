import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobKind, JobRecord } from "./job-store.js";

/**
 * Recovery of last resort: which agy conversations can still be continued.
 *
 * The sibling Codex plugins answer this by asking their CLI -- `opencode session
 * list --format json`. agy has no equivalent, and this was measured rather than
 * assumed:
 *
 *   - There is no `conversations` subcommand (`agy --help` lists agent, changelog,
 *     help, install, mcp, models, plugin, update, and nothing else).
 *   - `~/.gemini/antigravity-cli/conversations/` holds one SQLite triple per
 *     conversation (`<uuid>.db`, `-wal`, `-shm`). The tables are `trajectory_meta`,
 *     `steps`, `gen_metadata` and friends, and every payload column is an opaque
 *     protobuf blob. There is no title, timestamp or workspace column, and the
 *     `.db` alone is unreadable because the content lives in the WAL.
 *   - `~/.gemini/antigravity-cli/conversation_summaries.db` does have exactly the
 *     right columns -- conversation_id, title, workspace_uris, last_modified_time --
 *     but it is written by the Antigravity desktop app, not the CLI. On the machine
 *     this was measured on it held one row from two months earlier while the CLI was
 *     writing conversations that same minute.
 *
 * So the registry is this plugin's own job records, which is the honest scope: it
 * lists the conversations THIS PLUGIN started, and says so. A conversation started
 * by a bare `agy` invocation is not in here and cannot be, because agy does not
 * publish one.
 */

export type ConversationSummary = {
  conversationId: string;
  /** The job that produced it, so the full log can still be fetched. */
  jobId: string;
  kind: JobKind;
  cwd: string;
  status: JobRecord["status"];
  createdAt: string;
  finishedAt?: string;
  observedModel?: string;
  /** True when that job ended with an answer, rather than a failure or a timeout. */
  resultComplete?: boolean;
  /** First line of the answer, when the record kept one. */
  preview?: string;
};

/** Newest-first scan bound, so a long-lived state directory stays cheap to list. */
const MAX_RECORDS_SCANNED = 500;
const PREVIEW_CHARS = 200;

function toSummary(record: JobRecord): ConversationSummary | null {
  if (!record.agyConversationId) return null;
  const preview = record.terminalSummary?.finalTextPreview;
  return {
    conversationId: record.agyConversationId,
    jobId: record.id,
    kind: record.kind,
    cwd: record.cwd,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.observedModel ? { observedModel: record.observedModel } : {}),
    ...(record.terminalSummary ? { resultComplete: record.terminalSummary.resultComplete } : {}),
    ...(preview
      ? { preview: preview.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS) }
      : {})
  };
}

/**
 * List the agy conversations this plugin's job records know about, newest first.
 *
 * One conversation can back several jobs (a run and then its continuations); only
 * the most recent job for each conversation is returned, because that is the one
 * whose log still describes the conversation's current state.
 */
export async function listConversations(params: {
  stateDir: string;
  roots?: string[];
  includeAllDirectories?: boolean;
  limit?: number;
}): Promise<{ conversations: ConversationSummary[]; scanned: number; skipped: number }> {
  const jobsDir = join(params.stateDir, "jobs");
  let entries: string[];
  try {
    entries = (await readdir(jobsDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return { conversations: [], scanned: 0, skipped: 0 };
  }

  // Job ids embed their creation time (`job_<epochMs>_<random>`), so a lexical sort
  // is a chronological one for every id this plugin has ever minted.
  entries.sort().reverse();
  const scanned = entries.slice(0, MAX_RECORDS_SCANNED);

  const byConversation = new Map<string, ConversationSummary>();
  let skipped = 0;
  for (const name of scanned) {
    let record: JobRecord;
    try {
      record = JSON.parse(await readFile(join(jobsDir, name), "utf8")) as JobRecord;
    } catch {
      skipped += 1;
      continue;
    }
    const summary = toSummary(record);
    if (!summary) continue;
    // First write wins: the scan is newest-first, so this keeps the latest job.
    if (!byConversation.has(summary.conversationId)) {
      byConversation.set(summary.conversationId, summary);
    }
  }

  const all = [...byConversation.values()];
  const roots = params.roots ?? [];
  const scopedToWorkspace = !params.includeAllDirectories && roots.length > 0;
  const scoped = scopedToWorkspace
    ? all.filter((summary) => roots.some((root) => summary.cwd === root || summary.cwd.startsWith(`${root}/`)))
    : all;

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  return { conversations: scoped.slice(0, limit), scanned: scanned.length, skipped };
}

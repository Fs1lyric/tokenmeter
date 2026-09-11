/**
 * Local storage. One SQLite file under ~/.tokenmeter.
 * Nothing here ever leaves the machine.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CallRecord {
  ts: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  uncachedCostUsd: number;
  latencyMs: number;
  streamed: number;
  status: number;
  repo: string | null;
  branch: string | null;
  tag: string | null;
}

export interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  uncachedCostUsd: number;
}

export interface GroupedRow extends Totals {
  key: string;
}

export function dataDir(): string {
  const dir = process.env.TOKENMETER_HOME ?? join(homedir(), ".tokenmeter");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function openDb(): DatabaseSync {
  const db = new DatabaseSync(join(dataDir(), "usage.db"));

  // WAL keeps the proxy writing while a `report` reads in another terminal.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                 INTEGER NOT NULL,
      provider           TEXT    NOT NULL,
      model              TEXT    NOT NULL,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL    NOT NULL DEFAULT 0,
      uncached_cost_usd  REAL    NOT NULL DEFAULT 0,
      latency_ms         INTEGER NOT NULL DEFAULT 0,
      streamed           INTEGER NOT NULL DEFAULT 0,
      status             INTEGER NOT NULL DEFAULT 200,
      repo               TEXT,
      branch             TEXT,
      tag                TEXT
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_calls_model ON calls(model)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_calls_repo ON calls(repo)");

  return db;
}

export function insertCall(db: DatabaseSync, r: CallRecord): void {
  db.prepare(
    `INSERT INTO calls (
       ts, provider, model, input_tokens, output_tokens,
       cache_write_tokens, cache_read_tokens, cost_usd, uncached_cost_usd,
       latency_ms, streamed, status, repo, branch, tag
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.ts,
    r.provider,
    r.model,
    r.inputTokens,
    r.outputTokens,
    r.cacheWriteTokens,
    r.cacheReadTokens,
    r.costUsd,
    r.uncachedCostUsd,
    r.latencyMs,
    r.streamed,
    r.status,
    r.repo,
    r.branch,
    r.tag,
  );
}

const TOTALS_SELECT = `
  COUNT(*)                        AS calls,
  COALESCE(SUM(input_tokens),0)       AS inputTokens,
  COALESCE(SUM(output_tokens),0)      AS outputTokens,
  COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
  COALESCE(SUM(cache_read_tokens),0)  AS cacheReadTokens,
  COALESCE(SUM(cost_usd),0)           AS costUsd,
  COALESCE(SUM(uncached_cost_usd),0)  AS uncachedCostUsd
`;

export function totalsSince(db: DatabaseSync, sinceMs: number): Totals {
  const row = db
    .prepare(`SELECT ${TOTALS_SELECT} FROM calls WHERE ts >= ?`)
    .get(sinceMs) as Record<string, number> | undefined;

  return {
    calls: row?.["calls"] ?? 0,
    inputTokens: row?.["inputTokens"] ?? 0,
    outputTokens: row?.["outputTokens"] ?? 0,
    cacheWriteTokens: row?.["cacheWriteTokens"] ?? 0,
    cacheReadTokens: row?.["cacheReadTokens"] ?? 0,
    costUsd: row?.["costUsd"] ?? 0,
    uncachedCostUsd: row?.["uncachedCostUsd"] ?? 0,
  };
}

export type GroupBy = "model" | "repo" | "branch" | "tag" | "day" | "provider";

const GROUP_EXPR: Record<GroupBy, string> = {
  model: "model",
  repo: "COALESCE(repo, '(none)')",
  branch: "COALESCE(branch, '(none)')",
  tag: "COALESCE(tag, '(none)')",
  provider: "provider",
  day: "date(ts / 1000, 'unixepoch', 'localtime')",
};

export function groupedSince(
  db: DatabaseSync,
  sinceMs: number,
  by: GroupBy,
  limit = 50,
): GroupedRow[] {
  const expr = GROUP_EXPR[by];
  const rows = db
    .prepare(
      `SELECT ${expr} AS key, ${TOTALS_SELECT}
       FROM calls WHERE ts >= ?
       GROUP BY key
       ORDER BY costUsd DESC
       LIMIT ?`,
    )
    .all(sinceMs, limit) as unknown as GroupedRow[];

  return rows;
}

/** Cost per calendar day, oldest first — used to draw the sparkline. */
export function dailySeries(
  db: DatabaseSync,
  sinceMs: number,
): Array<{ day: string; costUsd: number }> {
  return db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
              COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM calls WHERE ts >= ?
       GROUP BY day ORDER BY day ASC`,
    )
    .all(sinceMs) as unknown as Array<{ day: string; costUsd: number }>;
}

export function recentCalls(db: DatabaseSync, limit: number): CallRecord[] {
  return db
    .prepare(
      `SELECT ts, provider, model,
              input_tokens       AS inputTokens,
              output_tokens      AS outputTokens,
              cache_write_tokens AS cacheWriteTokens,
              cache_read_tokens  AS cacheReadTokens,
              cost_usd           AS costUsd,
              uncached_cost_usd  AS uncachedCostUsd,
              latency_ms         AS latencyMs,
              streamed, status, repo, branch, tag
       FROM calls ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as unknown as CallRecord[];
}

export function clearBefore(db: DatabaseSync, beforeMs: number): number {
  const result = db.prepare("DELETE FROM calls WHERE ts < ?").run(beforeMs);
  return Number(result.changes);
}

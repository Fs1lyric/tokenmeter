/**
 * Report rendering. The question this answers is "where did the money go",
 * so every view leads with cost and breaks it down by something actionable.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  dailySeries,
  groupedSince,
  recentCalls,
  totalsSince,
  type GroupBy,
  type Totals,
} from "./db.js";
import { priceFor } from "./pricing.js";
import {
  bold,
  cyan,
  dim,
  fmtPct,
  fmtTokens,
  fmtUsd,
  green,
  sparkline,
  table,
  yellow,
} from "./format.js";

export interface ReportOptions {
  sinceMs: number;
  windowLabel: string;
  groupBy: GroupBy;
  limit: number;
}

function savings(t: Totals): number {
  return Math.max(0, t.uncachedCostUsd - t.costUsd);
}

function summaryBlock(t: Totals, label: string): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${bold(fmtUsd(t.costUsd))} ${dim(`over ${label}`)}`);
  lines.push(
    dim(
      `  ${t.calls} calls · ${fmtTokens(t.inputTokens)} in · ` +
        `${fmtTokens(t.outputTokens)} out`,
    ),
  );

  const saved = savings(t);
  if (saved > 0) {
    const pct = t.uncachedCostUsd > 0 ? saved / t.uncachedCostUsd : 0;
    lines.push(
      `  ${green(`Prompt caching saved ${fmtUsd(saved)}`)} ${dim(
        `(${fmtPct(pct)} off ${fmtUsd(t.uncachedCostUsd)} uncached)`,
      )}`,
    );
  } else if (t.cacheReadTokens === 0 && t.inputTokens > 50_000) {
    lines.push(
      `  ${yellow("No prompt caching detected.")} ${dim(
        "Large repeated prefixes are the cheapest win available.",
      )}`,
    );
  }

  return lines.join("\n");
}

export function renderReport(db: DatabaseSync, opts: ReportOptions): string {
  const totals = totalsSince(db, opts.sinceMs);

  if (totals.calls === 0) {
    return [
      "",
      dim(`  No calls recorded in the last ${opts.windowLabel}.`),
      "",
      "  Start the proxy, then point your app at it:",
      cyan("    tokenmeter proxy"),
      "",
    ].join("\n");
  }

  const out: string[] = [summaryBlock(totals, opts.windowLabel), ""];

  // Daily trend — only meaningful across more than one day.
  const series = dailySeries(db, opts.sinceMs);
  if (series.length > 1) {
    const spark = sparkline(series.map((d) => d.costUsd));
    const first = series[0]?.day ?? "";
    const last = series[series.length - 1]?.day ?? "";
    out.push(`  ${cyan(spark)}  ${dim(`${first} → ${last}`)}`);
    out.push("");
  }

  const rows = groupedSince(db, opts.sinceMs, opts.groupBy, opts.limit);
  const grandTotal = totals.costUsd || 1;

  out.push(dim(`  By ${opts.groupBy}`));
  out.push(
    table(
      [
        { header: opts.groupBy.toUpperCase() },
        { header: "COST", align: "right" },
        { header: "SHARE", align: "right" },
        { header: "CALLS", align: "right" },
        { header: "IN", align: "right" },
        { header: "OUT", align: "right" },
      ],
      rows.map((r) => [
        r.key,
        fmtUsd(r.costUsd),
        fmtPct(r.costUsd / grandTotal),
        String(r.calls),
        fmtTokens(r.inputTokens),
        fmtTokens(r.outputTokens),
      ]),
    ),
  );

  // Flag spend we couldn't price, so a missing table entry never looks free.
  const unpriced = rows.filter(
    (r) => opts.groupBy === "model" && !priceFor(r.key).known && r.costUsd === 0,
  );
  if (unpriced.length > 0) {
    out.push("");
    out.push(
      yellow(
        `  ${unpriced.length} model(s) have no price on file and are counted as $0:`,
      ),
    );
    out.push(dim(`    ${unpriced.map((r) => r.key).join(", ")}`));
    out.push(dim("    Add them to ~/.tokenmeter/pricing.json to fix the totals."));
  }

  out.push("");
  return out.join("\n");
}

export function renderTail(db: DatabaseSync, limit: number): string {
  const calls = recentCalls(db, limit);

  if (calls.length === 0) {
    return `\n${dim("  Nothing recorded yet.")}\n`;
  }

  const rows = calls.map((c) => [
    new Date(c.ts).toLocaleTimeString(),
    c.model,
    c.branch ?? c.repo ?? "—",
    fmtTokens(c.inputTokens),
    fmtTokens(c.outputTokens),
    c.cacheReadTokens > 0 ? fmtTokens(c.cacheReadTokens) : "—",
    fmtUsd(c.costUsd),
    `${c.latencyMs}ms`,
  ]);

  return (
    "\n" +
    table(
      [
        { header: "TIME" },
        { header: "MODEL" },
        { header: "WHERE" },
        { header: "IN", align: "right" },
        { header: "OUT", align: "right" },
        { header: "CACHED", align: "right" },
        { header: "COST", align: "right" },
        { header: "LATENCY", align: "right" },
      ],
      rows,
    ) +
    "\n"
  );
}

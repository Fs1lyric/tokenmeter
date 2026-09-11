/**
 * Cost regression testing.
 *
 * The unit of comparison is **cost per call**, not total cost. Total cost moves
 * whenever the number of test cases changes, which makes it useless as a gate —
 * adding a test would look like a regression. Cost per call isolates the thing
 * you actually control: how expensive each request is.
 *
 * A baseline is a small JSON file you commit to the repo. CI reads it, measures
 * the current run, and exits non-zero when a threshold is crossed.
 */

import type { DatabaseSync } from "node:sqlite";
import { totalsSince, groupedSince, type Filter, type Totals } from "./db.js";

export const BASELINE_VERSION = 1;
export const DEFAULT_BASELINE_PATH = ".tokenmeter-baseline.json";

export interface Metrics {
  calls: number;
  costUsd: number;
  costPerCall: number;
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  /** Share of input tokens served from the prompt cache, 0–1. */
  cacheHitRate: number;
}

export interface Baseline {
  version: number;
  createdAt: string;
  window: string;
  filter: Filter;
  metrics: Metrics;
  byModel: Record<string, Metrics>;
}

function metricsFrom(t: Totals): Metrics {
  const calls = t.calls;
  const safeDiv = (n: number, d: number) => (d === 0 ? 0 : n / d);

  // Cache reads are input tokens that happened to be cached, so the
  // denominator is billable input plus cached input.
  const totalInput = t.inputTokens + t.cacheReadTokens;

  return {
    calls,
    costUsd: t.costUsd,
    costPerCall: safeDiv(t.costUsd, calls),
    inputTokensPerCall: safeDiv(t.inputTokens, calls),
    outputTokensPerCall: safeDiv(t.outputTokens, calls),
    cacheHitRate: safeDiv(t.cacheReadTokens, totalInput),
  };
}

export function measure(
  db: DatabaseSync,
  sinceMs: number,
  filter: Filter,
): { metrics: Metrics; byModel: Record<string, Metrics> } {
  const metrics = metricsFrom(totalsSince(db, sinceMs, filter));

  const byModel: Record<string, Metrics> = {};
  for (const row of groupedSince(db, sinceMs, "model", 100, filter)) {
    byModel[row.key] = metricsFrom(row);
  }

  return { metrics, byModel };
}

export function buildBaseline(
  window: string,
  filter: Filter,
  measured: { metrics: Metrics; byModel: Record<string, Metrics> },
): Baseline {
  return {
    version: BASELINE_VERSION,
    createdAt: new Date().toISOString(),
    window,
    filter,
    metrics: measured.metrics,
    byModel: measured.byModel,
  };
}

export function parseBaseline(raw: string): Baseline {
  const parsed = JSON.parse(raw) as Partial<Baseline>;

  if (parsed.version !== BASELINE_VERSION) {
    throw new Error(
      `Baseline file is version ${String(parsed.version)}, expected ${BASELINE_VERSION}. ` +
        `Re-record it with: tokenmeter baseline save`,
    );
  }
  if (!parsed.metrics || typeof parsed.metrics.costPerCall !== "number") {
    throw new Error("Baseline file is missing metrics. Re-record it.");
  }

  return parsed as Baseline;
}

// ------------------------------------------------------------------ comparison

export interface Thresholds {
  /** Fail if cost per call rose by more than this fraction (0.15 = 15%). */
  maxIncrease: number;
  /** Fail if cost per call exceeds this absolute USD figure. 0 disables. */
  maxCostPerCall: number;
  /** Fail if fewer than this many calls were recorded. Guards empty runs. */
  minCalls: number;
  /**
   * Fail if the cache hit rate fell by more than this fraction of its baseline
   * value. 0 disables — a collapse is then only a warning.
   *
   * Worth gating on separately from cost: a broken cache prefix can crater the
   * hit rate while cost per call barely moves, then bite once traffic scales.
   */
  maxCacheDrop: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxIncrease: 0.15,
  maxCostPerCall: 0,
  minCalls: 1,
  maxCacheDrop: 0,
};

export interface Delta {
  label: string;
  before: number;
  after: number;
  /** Fractional change; null when `before` is 0 and a ratio is meaningless. */
  change: number | null;
}

export interface Verdict {
  passed: boolean;
  /** Human-readable reasons the run failed. Empty when passed. */
  failures: string[];
  /** Notes worth printing that are not failures. */
  warnings: string[];
  deltas: Delta[];
  baselineMetrics: Metrics;
  currentMetrics: Metrics;
}

function delta(label: string, before: number, after: number): Delta {
  return {
    label,
    before,
    after,
    change: before === 0 ? null : (after - before) / before,
  };
}

export function compare(
  baseline: Baseline,
  current: Metrics,
  thresholds: Thresholds,
): Verdict {
  const base = baseline.metrics;
  const failures: string[] = [];
  const warnings: string[] = [];

  const deltas: Delta[] = [
    delta("cost / call", base.costPerCall, current.costPerCall),
    delta("input tokens / call", base.inputTokensPerCall, current.inputTokensPerCall),
    delta("output tokens / call", base.outputTokensPerCall, current.outputTokensPerCall),
    delta("cache hit rate", base.cacheHitRate, current.cacheHitRate),
  ];

  if (current.calls < thresholds.minCalls) {
    failures.push(
      `Only ${current.calls} call(s) recorded, expected at least ${thresholds.minCalls}. ` +
        `Did the proxy actually receive traffic?`,
    );
  }

  const costDelta = deltas[0];
  if (costDelta?.change !== null && costDelta !== undefined) {
    if (costDelta.change > thresholds.maxIncrease) {
      failures.push(
        `Cost per call rose ${(costDelta.change * 100).toFixed(1)}%, ` +
          `over the ${(thresholds.maxIncrease * 100).toFixed(0)}% threshold.`,
      );
    }
  }

  if (thresholds.maxCostPerCall > 0 && current.costPerCall > thresholds.maxCostPerCall) {
    failures.push(
      `Cost per call is $${current.costPerCall.toFixed(4)}, ` +
        `over the $${thresholds.maxCostPerCall.toFixed(4)} ceiling.`,
    );
  }

  // Falling cache hit rate usually precedes a cost rise — surface it even when
  // this run still passes on cost, and gate on it when asked to.
  if (base.cacheHitRate > 0.01) {
    const drop = (base.cacheHitRate - current.cacheHitRate) / base.cacheHitRate;
    const describe =
      `Cache hit rate dropped from ${(base.cacheHitRate * 100).toFixed(0)}% ` +
      `to ${(current.cacheHitRate * 100).toFixed(0)}%`;

    if (thresholds.maxCacheDrop > 0 && drop > thresholds.maxCacheDrop) {
      failures.push(
        `${describe} — a ${(drop * 100).toFixed(0)}% fall, over the ` +
          `${(thresholds.maxCacheDrop * 100).toFixed(0)}% threshold.`,
      );
    } else if (drop > 0.5) {
      warnings.push(`${describe}. Something is invalidating the prefix.`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    deltas,
    baselineMetrics: base,
    currentMetrics: current,
  };
}

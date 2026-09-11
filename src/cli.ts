#!/usr/bin/env node
/**
 * tokenmeter — know where your LLM spend goes.
 *
 * Everything is local: a proxy writes to a SQLite file in ~/.tokenmeter and the
 * report commands read it back. No account, no telemetry, no network calls of
 * our own.
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearBefore, dataDir, openDb, type Filter, type GroupBy } from "./db.js";
import { loadPricingOverrides, PRICING } from "./pricing.js";
import { envVarFor, startProxy } from "./proxy.js";
import { renderReport, renderTail, renderVerdict } from "./report.js";
import {
  buildBaseline,
  compare,
  DEFAULT_BASELINE_PATH,
  DEFAULT_THRESHOLDS,
  measure,
  parseBaseline,
  type Thresholds,
} from "./baseline.js";
import { bold, cyan, dim, fmtUsd, parseDuration, table } from "./format.js";

const VERSION = "0.1.0";

const UPSTREAMS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

const GROUP_KEYS: GroupBy[] = ["model", "repo", "branch", "tag", "day", "provider"];

function usage(): string {
  return `
${bold("tokenmeter")} ${dim(`v${VERSION}`)} — know where your LLM spend goes

${dim("USAGE")}
  tokenmeter <command> [options]

${dim("COMMANDS")}
  proxy              Start the measuring proxy
  report             Show spend, grouped and summarised
  tail               Show the most recent calls
  baseline save      Record current cost-per-call as a baseline
  ci                 Compare against the baseline; exit 1 on regression
  models             List known models and their prices
  prune              Delete records older than a cutoff
  where              Print the data directory

${dim("PROXY OPTIONS")}
  --port <n>         Port to listen on              ${dim("(default 8787)")}
  --provider <name>  anthropic | openai             ${dim("(default anthropic)")}
  --upstream <url>   Override the provider base URL
  --budget <usd>     Warn once today's spend passes this
  --verbose          Print a line per call

${dim("REPORT OPTIONS")}
  --since <dur>      Window: 30m, 24h, 7d, 4w       ${dim("(default 7d)")}
  --by <key>         ${GROUP_KEYS.join(" | ")}  ${dim("(default model)")}
  --limit <n>        Max rows                       ${dim("(default 20)")}
  --json             Emit JSON instead of a table

${dim("CI OPTIONS")}
  --file <path>            Baseline file    ${dim("(default .tokenmeter-baseline.json)")}
  --max-increase <pct>     Fail above this rise in cost/call  ${dim("(default 15%)")}
  --max-cost-per-call <n>  Absolute USD ceiling per call
  --max-cache-drop <pct>   Fail if the cache hit rate falls this much
  --min-calls <n>          Fail if fewer calls than this were seen
  --tag / --repo / --branch / --model   Narrow to one slice of traffic

${dim("EXAMPLES")}
  ${cyan("tokenmeter proxy --budget 5")}
  ${cyan("export ANTHROPIC_BASE_URL=http://127.0.0.1:8787")}
  ${cyan("tokenmeter report --since 24h --by branch")}
  ${cyan("tokenmeter tail --limit 10")}

  ${dim("# on main, after running your evals through the proxy")}
  ${cyan("tokenmeter baseline save --since 1h --tag evals")}
  ${dim("# on a PR branch, after the same run")}
  ${cyan("tokenmeter ci --max-increase 10%")}

${dim("ATTRIBUTION")}
  Repo and branch are read from git where the proxy was started.
  Override per request with headers:
    x-tokenmeter-tag: eval-suite
    x-tokenmeter-repo: my-service
  Or per process with TOKENMETER_TAG / TOKENMETER_REPO / TOKENMETER_BRANCH.
`;
}

function loadOverrides(): void {
  try {
    const raw = readFileSync(join(dataDir(), "pricing.json"), "utf8");
    loadPricingOverrides(raw);
  } catch {
    // No override file is the normal case.
  }
}

function fail(message: string): never {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(1);
}

/** Collect the --tag/--repo/--branch/--model narrowing flags. */
function filterFrom(values: Record<string, unknown>): Filter {
  const filter: Filter = {};
  for (const key of ["tag", "repo", "branch", "model"] as const) {
    const value = values[key];
    if (typeof value === "string" && value.length > 0) filter[key] = value;
  }
  return filter;
}

function describeFilter(filter: Filter): string {
  const parts = Object.entries(filter).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? ` matching ${parts.join(", ")}` : "";
}

/** Accept both `15%` and `0.15` for threshold flags. */
function parsePercent(input: string): number {
  const trimmed = input.trim();
  if (trimmed.endsWith("%")) {
    return Number(trimmed.slice(0, -1)) / 100;
  }
  return Number(trimmed);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      port: { type: "string" },
      provider: { type: "string" },
      upstream: { type: "string" },
      budget: { type: "string" },
      verbose: { type: "boolean", default: false },
      since: { type: "string" },
      by: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      before: { type: "string" },
      yes: { type: "boolean", default: false },
      file: { type: "string" },
      tag: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      model: { type: "string" },
      "max-increase": { type: "string" },
      "max-cost-per-call": { type: "string" },
      "min-calls": { type: "string" },
      "max-cache-drop": { type: "string" },
    },
  });

  loadOverrides();

  switch (command) {
    case "proxy": {
      const provider = values.provider ?? "anthropic";
      const upstream = values.upstream ?? UPSTREAMS[provider];
      if (!upstream) {
        fail(
          `Unknown provider "${provider}". Use anthropic or openai, ` +
            `or pass --upstream <url>.`,
        );
      }

      const port = values.port ? Number(values.port) : 8787;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        fail(`Invalid --port "${values.port}".`);
      }

      const budget = values.budget ? Number(values.budget) : 0;
      if (values.budget !== undefined && !Number.isFinite(budget)) {
        fail(`Invalid --budget "${values.budget}". Expected a number of dollars.`);
      }

      const db = openDb();
      await startProxy({
        db,
        port,
        upstream,
        provider,
        dailyBudget: budget,
        verbose: values.verbose === true,
      });
      db.close();
      return;
    }

    case "report": {
      const sinceRaw = values.since ?? "7d";
      const windowMs = parseDuration(sinceRaw);
      if (windowMs === null) {
        fail(`Invalid --since "${sinceRaw}". Try 30m, 24h, 7d, or 4w.`);
      }

      const by = (values.by ?? "model") as GroupBy;
      if (!GROUP_KEYS.includes(by)) {
        fail(`Invalid --by "${by}". Expected one of: ${GROUP_KEYS.join(", ")}.`);
      }

      const limit = values.limit ? Number(values.limit) : 20;
      if (!Number.isInteger(limit) || limit < 1) {
        fail(`Invalid --limit "${values.limit}".`);
      }

      const db = openDb();
      const sinceMs = Date.now() - windowMs;

      if (values.json === true) {
        const { groupedSince, totalsSince } = await import("./db.js");
        process.stdout.write(
          JSON.stringify(
            {
              window: sinceRaw,
              since: new Date(sinceMs).toISOString(),
              groupBy: by,
              totals: totalsSince(db, sinceMs),
              rows: groupedSince(db, sinceMs, by, limit),
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stdout.write(
          renderReport(db, { sinceMs, windowLabel: sinceRaw, groupBy: by, limit }),
        );
      }

      db.close();
      return;
    }

    case "tail": {
      const limit = values.limit ? Number(values.limit) : 20;
      if (!Number.isInteger(limit) || limit < 1) {
        fail(`Invalid --limit "${values.limit}".`);
      }
      const db = openDb();
      process.stdout.write(renderTail(db, limit));
      db.close();
      return;
    }

    case "models": {
      const rows = Object.entries(PRICING).map(([id, p]) => [
        id,
        `$${p.input.toFixed(2)}`,
        `$${p.output.toFixed(2)}`,
        `${p.cacheReadMultiplier}x`,
      ]);
      process.stdout.write(
        "\n" +
          table(
            [
              { header: "MODEL" },
              { header: "IN / 1M", align: "right" },
              { header: "OUT / 1M", align: "right" },
              { header: "CACHE READ", align: "right" },
            ],
            rows,
          ) +
          "\n\n" +
          dim(`  Override any of these in ${join(dataDir(), "pricing.json")}\n\n`),
      );
      return;
    }

    case "prune": {
      const beforeRaw = values.before ?? "90d";
      const windowMs = parseDuration(beforeRaw);
      if (windowMs === null) {
        fail(`Invalid --before "${beforeRaw}". Try 30d or 12w.`);
      }

      const cutoff = Date.now() - windowMs;
      const db = openDb();

      if (values.yes !== true) {
        const { totalsSince } = await import("./db.js");
        const all = totalsSince(db, 0);
        const keeping = totalsSince(db, cutoff);
        const deleting = all.calls - keeping.calls;
        process.stdout.write(
          `\n  This would delete ${bold(String(deleting))} calls older than ` +
            `${beforeRaw} (${fmtUsd(all.costUsd - keeping.costUsd)} of recorded spend).\n` +
            `  Re-run with ${cyan("--yes")} to confirm.\n\n`,
        );
        db.close();
        return;
      }

      const deleted = clearBefore(db, cutoff);
      db.close();
      process.stdout.write(`\n  Deleted ${deleted} records older than ${beforeRaw}.\n\n`);
      return;
    }

    case "baseline": {
      const sub = argv[1];
      if (sub !== "save" && sub !== "show") {
        fail(`Usage: tokenmeter baseline save|show [options]`);
      }

      const path = values.file ?? DEFAULT_BASELINE_PATH;

      if (sub === "show") {
        try {
          const b = parseBaseline(readFileSync(path, "utf8"));
          process.stdout.write(JSON.stringify(b, null, 2) + "\n");
        } catch (err) {
          fail(
            `Could not read baseline at ${path}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        return;
      }

      const sinceRaw = values.since ?? "1h";
      const windowMs = parseDuration(sinceRaw);
      if (windowMs === null) {
        fail(`Invalid --since "${sinceRaw}". Try 30m, 1h, or 24h.`);
      }

      const filter = filterFrom(values);
      const db = openDb();
      const measured = measure(db, Date.now() - windowMs, filter);
      db.close();

      if (measured.metrics.calls === 0) {
        fail(
          `No calls recorded in the last ${sinceRaw}` +
            `${describeFilter(filter)}. Nothing to baseline.`,
        );
      }

      const baseline = buildBaseline(sinceRaw, filter, measured);
      writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");

      process.stdout.write(
        `\n  Baseline written to ${bold(path)}\n` +
          dim(
            `  ${measured.metrics.calls} calls · ` +
              `${fmtUsd(measured.metrics.costPerCall)} per call · ` +
              `${(measured.metrics.cacheHitRate * 100).toFixed(0)}% cache hit rate\n`,
          ) +
          dim(`  Commit this file so CI can compare against it.\n\n`),
      );
      return;
    }

    case "ci": {
      const path = values.file ?? DEFAULT_BASELINE_PATH;

      let baseline;
      try {
        baseline = parseBaseline(readFileSync(path, "utf8"));
      } catch (err) {
        fail(
          `Could not read baseline at ${path}: ` +
            (err instanceof Error ? err.message : String(err)) +
            `\n  Record one with: tokenmeter baseline save`,
        );
      }

      // Default to the same window and filter the baseline used, so the two
      // sides of the comparison are measured the same way unless overridden.
      const sinceRaw = values.since ?? baseline.window;
      const windowMs = parseDuration(sinceRaw);
      if (windowMs === null) {
        fail(`Invalid --since "${sinceRaw}".`);
      }

      const explicit = filterFrom(values);
      const filter = Object.keys(explicit).length > 0 ? explicit : baseline.filter;

      const thresholds: Thresholds = {
        maxIncrease: values["max-increase"]
          ? parsePercent(values["max-increase"])
          : DEFAULT_THRESHOLDS.maxIncrease,
        maxCostPerCall: values["max-cost-per-call"]
          ? Number(values["max-cost-per-call"])
          : DEFAULT_THRESHOLDS.maxCostPerCall,
        minCalls: values["min-calls"]
          ? Number(values["min-calls"])
          : DEFAULT_THRESHOLDS.minCalls,
        maxCacheDrop: values["max-cache-drop"]
          ? parsePercent(values["max-cache-drop"])
          : DEFAULT_THRESHOLDS.maxCacheDrop,
      };

      if (!Number.isFinite(thresholds.maxIncrease)) {
        fail(`Invalid --max-increase "${values["max-increase"]}". Try 15% or 0.15.`);
      }

      const db = openDb();
      const current = measure(db, Date.now() - windowMs, filter);
      db.close();

      const verdict = compare(baseline, current.metrics, thresholds);

      if (values.json === true) {
        process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
      } else {
        process.stdout.write(renderVerdict(verdict));
      }

      process.exit(verdict.passed ? 0 : 1);
    }

    case "where": {
      process.stdout.write(`${dataDir()}\n`);
      return;
    }

    default:
      fail(
        `Unknown command "${command}". Run ${cyan("tokenmeter help")} for usage.`,
      );
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n  tokenmeter: ${message}\n\n`);
  process.exit(1);
});

// Referenced in help text so the linker keeps it; also the canonical place to
// look up which env var a given provider reads.
export { envVarFor };

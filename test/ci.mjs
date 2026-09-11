/**
 * CI gate test.
 *
 * Simulates the real shape of the workflow: the baseline is recorded on one
 * machine (its own data dir) and the PR run happens on a fresh one, the way a
 * CI runner starts clean each time.
 *
 * Run with:  node test/ci.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
const { openDb, insertCall } = await import(join(ROOT, "dist/db.js"));
const { costOf, uncachedCostOf } = await import(join(ROOT, "dist/pricing.js"));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

/** Write `count` identical calls of a given size into a fresh data dir. */
function seed(home, { count, inputTokens, outputTokens, cacheReadTokens = 0 }) {
  const prev = process.env.TOKENMETER_HOME;
  process.env.TOKENMETER_HOME = home;
  const db = openDb();
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const usage = { inputTokens, outputTokens, cacheWriteTokens: 0, cacheReadTokens };
    insertCall(db, {
      ts: now - i * 1000,
      provider: "anthropic",
      model: "claude-sonnet-5",
      ...usage,
      costUsd: costOf("claude-sonnet-5", usage),
      uncachedCostUsd: uncachedCostOf("claude-sonnet-5", usage),
      latencyMs: 900,
      streamed: 1,
      status: 200,
      repo: "demo",
      branch: "main",
      tag: "evals",
    });
  }
  db.close();
  process.env.TOKENMETER_HOME = prev;
}

function run(home, args) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: ROOT,
    env: { ...process.env, TOKENMETER_HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
  });
}

const mainHome = mkdtempSync(join(tmpdir(), "tm-main-"));
const prHome = mkdtempSync(join(tmpdir(), "tm-pr-"));
const cheapHome = mkdtempSync(join(tmpdir(), "tm-cheap-"));
const emptyHome = mkdtempSync(join(tmpdir(), "tm-empty-"));
const baselineFile = join(mkdtempSync(join(tmpdir(), "tm-bl-")), "baseline.json");

try {
  console.log("\nbaseline");

  // Baseline run: 20 calls, 1000 in / 500 out each.
  seed(mainHome, { count: 20, inputTokens: 1000, outputTokens: 500 });
  const saved = run(mainHome, [
    "baseline", "save", "--since", "1h", "--tag", "evals", "--file", baselineFile,
  ]);

  check("baseline save exits 0", () => {
    assert.equal(saved.status, 0, saved.stderr);
  });

  check("baseline file records cost per call", () => {
    const b = JSON.parse(readFileSync(baselineFile, "utf8"));
    // 1000 in @ $3/M = $0.003, 500 out @ $15/M = $0.0075 → $0.0105
    assert.ok(
      Math.abs(b.metrics.costPerCall - 0.0105) < 1e-9,
      `got ${b.metrics.costPerCall}`,
    );
    assert.equal(b.metrics.calls, 20);
  });

  console.log("\nregression detection");

  // PR run: same call count, but prompts got 60% bigger.
  seed(prHome, { count: 20, inputTokens: 1600, outputTokens: 500 });
  const regressed = run(prHome, [
    "ci", "--file", baselineFile, "--max-increase", "15%",
  ]);

  check("ci exits 1 when cost per call rises past the threshold", () => {
    assert.equal(regressed.status, 1, `stdout:\n${regressed.stdout}`);
  });

  check("ci explains the failure in plain numbers", () => {
    assert.match(regressed.stdout, /FAIL/);
    assert.match(regressed.stdout, /Cost per call rose/);
  });

  check("ci shows the before/after table", () => {
    assert.match(regressed.stdout, /cost \/ call/);
    assert.match(regressed.stdout, /input tokens \/ call/);
  });

  console.log("\npassing runs");

  // A small rise that stays under the threshold must pass.
  seed(cheapHome, { count: 20, inputTokens: 1050, outputTokens: 500 });
  const ok = run(cheapHome, ["ci", "--file", baselineFile, "--max-increase", "15%"]);

  check("ci exits 0 when the change is within tolerance", () => {
    assert.equal(ok.status, 0, `stdout:\n${ok.stdout}`);
  });

  check("ci says PASS", () => {
    assert.match(ok.stdout, /PASS/);
  });

  console.log("\nguards");

  const empty = run(emptyHome, ["ci", "--file", baselineFile]);

  check("ci fails loudly when no traffic was recorded", () => {
    assert.equal(empty.status, 1);
    assert.match(empty.stdout, /Did the proxy actually receive traffic\?/);
  });

  const ceiling = run(cheapHome, [
    "ci", "--file", baselineFile, "--max-cost-per-call", "0.001",
  ]);

  check("ci enforces an absolute cost-per-call ceiling", () => {
    assert.equal(ceiling.status, 1);
    assert.match(ceiling.stdout, /over the \$0\.0010 ceiling/);
  });

  const missing = run(cheapHome, ["ci", "--file", "/nonexistent/baseline.json"]);

  check("ci gives an actionable error for a missing baseline", () => {
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /tokenmeter baseline save/);
  });

  console.log("\ncache regression");

  // A cached baseline whose prefix later breaks: cost per call barely moves,
  // but the hit rate collapses. This is the case a pure cost gate misses.
  const cachedHome = mkdtempSync(join(tmpdir(), "tm-cached-"));
  const brokenHome = mkdtempSync(join(tmpdir(), "tm-broken-"));
  const cacheBaseline = join(mkdtempSync(join(tmpdir(), "tm-cb-")), "baseline.json");

  seed(cachedHome, {
    count: 20, inputTokens: 1200, outputTokens: 600, cacheReadTokens: 9000,
  });
  run(cachedHome, [
    "baseline", "save", "--since", "1h", "--tag", "evals", "--file", cacheBaseline,
  ]);

  seed(brokenHome, {
    count: 20, inputTokens: 2100, outputTokens: 640, cacheReadTokens: 400,
  });

  const cacheWarn = run(brokenHome, [
    "ci", "--file", cacheBaseline, "--max-increase", "15%",
  ]);

  check("a cache collapse under a passing cost gate still warns", () => {
    assert.equal(cacheWarn.status, 0, cacheWarn.stdout);
    assert.match(cacheWarn.stdout, /Cache hit rate dropped/);
  });

  const cacheGate = run(brokenHome, [
    "ci", "--file", cacheBaseline, "--max-increase", "15%", "--max-cache-drop", "50%",
  ]);

  check("--max-cache-drop turns that collapse into a failure", () => {
    assert.equal(cacheGate.status, 1, cacheGate.stdout);
    assert.match(cacheGate.stdout, /over the 50% threshold/);
  });

  rmSync(cachedHome, { recursive: true, force: true });
  rmSync(brokenHome, { recursive: true, force: true });

  const asJson = run(prHome, ["ci", "--file", baselineFile, "--json"]);

  check("ci --json emits a machine-readable verdict", () => {
    const v = JSON.parse(asJson.stdout);
    assert.equal(v.passed, false);
    assert.ok(Array.isArray(v.deltas));
    assert.ok(v.failures.length > 0);
  });
} finally {
  for (const dir of [mainHome, prHome, cheapHome, emptyHome]) {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log("all checks passed\n");

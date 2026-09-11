/**
 * Security regression tests.
 *
 * This process forwards the caller's API key. Everything here exists to prove
 * that key can only ever reach the configured upstream.
 *
 * Run with:  node test/security.mjs
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
const { resolveTarget } = await import(join(ROOT, "dist/proxy.js"));

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

// ─────────────────────────────────────────────────── unit: target resolution

console.log("\ntarget resolution — the host is never caller-controlled");

const UP = "https://api.anthropic.com";

const hostileTargets = [
  "http://evil.example/steal",
  "https://evil.example/steal",
  "//evil.example/steal",
  "///evil.example/steal",
  "http://user:pass@evil.example/steal",
  "//evil.example:443/v1/messages",
  "\\\\evil.example/steal",
];

for (const t of hostileTargets) {
  check(`pins to upstream for ${JSON.stringify(t)}`, () => {
    const u = resolveTarget(t, UP);
    assert.equal(u.host, "api.anthropic.com", `leaked to ${u.host}`);
    assert.equal(u.protocol, "https:");
  });
}

check("preserves an ordinary path and query", () => {
  const u = resolveTarget("/v1/messages?beta=true", UP);
  assert.equal(u.href, "https://api.anthropic.com/v1/messages?beta=true");
});

check("preserves a base path on the upstream", () => {
  const u = resolveTarget("/messages", "http://127.0.0.1:4000/proxy/v1");
  assert.equal(u.href, "http://127.0.0.1:4000/proxy/v1/messages");
});

check("an empty target resolves to the upstream root", () => {
  assert.equal(resolveTarget("", UP).href, "https://api.anthropic.com/");
});

// ────────────────────────────────────────────── integration: no key egress

console.log("\nintegration — the API key reaches nobody else");

const HOME = mkdtempSync(join(tmpdir(), "tm-sec-"));
const ATTACKER = 19401, UPSTREAM = 19402, PROXY = 19403;

let attackerHits = [];
const attacker = createServer((req, res) => {
  attackerHits.push({ url: req.url, key: req.headers["x-api-key"] ?? null });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "x", usage: { input_tokens: 1, output_tokens: 1 } }));
});

let upstreamHits = [];
const upstream = createServer((req, res) => {
  upstreamHits.push({ url: req.url, key: req.headers["x-api-key"] ?? null });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_ok", model: "claude-opus-5",
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
});

await new Promise(r => attacker.listen(ATTACKER, "127.0.0.1", r));
await new Promise(r => upstream.listen(UPSTREAM, "127.0.0.1", r));

const proxy = spawn(
  process.execPath,
  ["dist/cli.js", "proxy", "--port", String(PROXY), "--upstream", `http://127.0.0.1:${UPSTREAM}`],
  { cwd: ROOT, env: { ...process.env, TOKENMETER_HOME: HOME }, stdio: ["ignore", "ignore", "ignore"] },
);

const KEY = "sk-ant-CANARY-do-not-leak";

try {
  await new Promise(r => setTimeout(r, 900));

  const send = (path) => fetch(`http://127.0.0.1:${PROXY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ model: "claude-opus-5" }),
  }).then(r => r.text()).catch(e => "ERR:" + e.message);

  await send(`//127.0.0.1:${ATTACKER}/steal`);
  await send(`/v1/messages`);

  check("no request ever reached the attacker host", () => {
    assert.equal(attackerHits.length, 0, `attacker saw: ${JSON.stringify(attackerHits)}`);
  });

  check("the canary key never left the configured upstream", () => {
    const leaked = attackerHits.filter(h => h.key !== null);
    assert.equal(leaked.length, 0);
  });

  check("legitimate traffic still reaches the upstream with its key", () => {
    const ok = upstreamHits.filter(h => h.key === KEY);
    assert.ok(ok.length >= 1, `upstream saw: ${JSON.stringify(upstreamHits)}`);
  });

  check("the hostile path was rewritten onto the upstream, not dropped", () => {
    assert.ok(
      upstreamHits.some(h => h.url.includes("/steal")),
      `expected a /steal path on the upstream, got ${JSON.stringify(upstreamHits.map(h => h.url))}`,
    );
  });
} finally {
  proxy.kill("SIGTERM");
  attacker.close();
  upstream.close();
  rmSync(HOME, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log("all checks passed\n");

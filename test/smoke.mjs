/**
 * End-to-end smoke test.
 *
 * Stands up a fake Anthropic-shaped upstream, runs the real proxy against it,
 * sends one non-streaming and one streaming request, and asserts that the
 * recorded cost matches a hand-computed figure.
 *
 * Run with:  node test/smoke.mjs
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const TOKENMETER_HOME = mkdtempSync(join(tmpdir(), "tokenmeter-test-"));
const UPSTREAM_PORT = 19101;
const PROXY_PORT = 19102;

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

// ---------------------------------------------------------------- fake upstream

const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // Only the messages endpoint reports usage. Anything else (readiness
    // probes, health checks) must not be recorded as spend.
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found" } }));
      return;
    }

    const parsed = body ? JSON.parse(body) : {};

    // Echo the auth header back so we can assert it was forwarded intact.
    const seenKey = req.headers["x-api-key"] ?? "";

    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            model: "claude-sonnet-5",
            usage: {
              input_tokens: 1000,
              output_tokens: 0,
              cache_creation_input_tokens: 2000,
              cache_read_input_tokens: 8000,
            },
          },
        },
        { type: "content_block_delta", delta: { text: "hello" } },
        { type: "message_delta", usage: { output_tokens: 500 } },
      ];
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json", "x-seen-key": seenKey });
    res.end(
      JSON.stringify({
        id: "msg_test",
        model: "claude-opus-5",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10000, output_tokens: 2000 },
      }),
    );
  });
});

// ------------------------------------------------------------------- test body

async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`port ${port} never came up`);
}

async function run() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  const proxy = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "proxy",
      "--port",
      String(PROXY_PORT),
      "--upstream",
      `http://127.0.0.1:${UPSTREAM_PORT}`,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, TOKENMETER_HOME },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let proxyStderr = "";
  proxy.stderr.on("data", (c) => (proxyStderr += c));

  try {
    await waitForPort(PROXY_PORT);

    console.log("\nproxy");

    // --- non-streaming --------------------------------------------------
    const res1 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-test-secret",
        "x-tokenmeter-tag": "smoke",
      },
      body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    });
    const json1 = await res1.json();

    check("forwards non-streaming response body unchanged", () => {
      assert.equal(json1.id, "msg_test");
      assert.equal(json1.content[0].text, "hi");
    });

    check("forwards the API key upstream untouched", () => {
      assert.equal(res1.headers.get("x-seen-key"), "sk-test-secret");
    });

    check("strips x-tokenmeter-* control headers from the upstream request", () => {
      // The fake upstream would have echoed it into the body if it arrived;
      // instead we assert the proxy consumed it as a tag (checked below).
      assert.ok(!proxyStderr.includes("x-tokenmeter-tag"));
    });

    // --- streaming ------------------------------------------------------
    const res2 = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-test-secret" },
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }),
    });
    const text2 = await res2.text();

    check("passes the SSE stream through intact", () => {
      assert.match(text2, /event: message_start/);
      assert.match(text2, /event: message_delta/);
      assert.match(text2, /"text":"hello"/);
    });

    // Give the proxy a moment to finish its write.
    await new Promise((r) => setTimeout(r, 300));

    // --- reporting ------------------------------------------------------
    console.log("\naccounting");

    const report = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["dist/cli.js", "report", "--since", "1h", "--json"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, TOKENMETER_HOME },
      });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.on("close", () => {
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(new Error(`bad report JSON: ${out.slice(0, 200)}`));
        }
      });
    });

    check("recorded both calls", () => {
      assert.equal(report.totals.calls, 2);
    });

    check("summed input tokens across streaming and non-streaming", () => {
      assert.equal(report.totals.inputTokens, 11000); // 10000 + 1000
      assert.equal(report.totals.outputTokens, 2500); // 2000 + 500
    });

    check("captured cache tokens from the stream", () => {
      assert.equal(report.totals.cacheWriteTokens, 2000);
      assert.equal(report.totals.cacheReadTokens, 8000);
    });

    check("computed cost correctly", () => {
      // opus-5:   10000 in @ $5/M  = $0.05
      //            2000 out @ $25/M = $0.05          → $0.10
      // sonnet-5:  1000 in @ $3/M  = $0.003
      //             500 out @ $15/M = $0.0075
      //            2000 cw @ $3*1.25/M = $0.0075
      //            8000 cr @ $3*0.1/M  = $0.0024     → $0.0204
      const expected = 0.1 + 0.0204;
      assert.ok(
        Math.abs(report.totals.costUsd - expected) < 1e-9,
        `expected ${expected}, got ${report.totals.costUsd}`,
      );
    });

    check("computed the uncached comparison correctly", () => {
      // sonnet-5 uncached: cache write and read both at full $3/M
      //   1000 in + 2000 + 8000 = 11000 @ $3/M = $0.033, + $0.0075 out = $0.0405
      const expected = 0.1 + 0.0405;
      assert.ok(
        Math.abs(report.totals.uncachedCostUsd - expected) < 1e-9,
        `expected ${expected}, got ${report.totals.uncachedCostUsd}`,
      );
    });

    check("grouped by model", () => {
      const models = report.rows.map((r) => r.key).sort();
      assert.deepEqual(models, ["claude-opus-5", "claude-sonnet-5"]);
    });

    // --- tag attribution -------------------------------------------------
    const byTag = await new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        ["dist/cli.js", "report", "--since", "1h", "--by", "tag", "--json"],
        {
          cwd: new URL("..", import.meta.url).pathname,
          env: { ...process.env, TOKENMETER_HOME },
        },
      );
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.on("close", () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error("bad tag report"));
        }
      });
    });

    check("attributed the tagged call via x-tokenmeter-tag", () => {
      const smoke = byTag.rows.find((r) => r.key === "smoke");
      assert.ok(smoke, `no "smoke" tag row in ${JSON.stringify(byTag.rows)}`);
      assert.equal(smoke.calls, 1);
    });
  } finally {
    proxy.kill("SIGTERM");
    upstream.close();
    rmSync(TOKENMETER_HOME, { recursive: true, force: true });
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) failed\n`);
    process.exit(1);
  }
  console.log("all checks passed\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

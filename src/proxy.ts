/**
 * The measuring proxy.
 *
 * It sits in front of a provider's API, forwards every request byte-for-byte,
 * and reads the usage numbers out of the response on the way back. Your code
 * changes by exactly one environment variable.
 *
 * Two rules this file must never break:
 *   1. Credentials are forwarded and never stored, logged, or inspected.
 *   2. A failure in the metering path must not corrupt the proxied response.
 *      Every parse is wrapped; the bytes go through regardless.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { insertCall, totalsSince, type CallRecord } from "./db.js";
import { costOf, uncachedCostOf, type TokenUsage } from "./pricing.js";
import { resolveContext, type AttributionContext } from "./context.js";
import { fmtUsd } from "./format.js";

/** Headers that describe a single hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Our own control headers — consumed here, never sent upstream. */
const CONTROL_PREFIX = "x-tokenmeter-";

export interface ProxyOptions {
  db: DatabaseSync;
  port: number;
  upstream: string;
  provider: string;
  /** Warn on stderr once today's spend crosses this many USD. 0 disables. */
  dailyBudget: number;
  /** Print a one-line summary for every call. */
  verbose: boolean;
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Pull usage out of a non-streaming response body.
 * Handles Anthropic's shape and OpenAI's shape; unknown shapes yield zeroes.
 */
function parseUsageFromJson(body: string): { model: string; usage: TokenUsage } | null {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const model = typeof json["model"] === "string" ? json["model"] : "";
    const usage = json["usage"] as Record<string, number> | undefined;
    if (!usage) return null;

    // Anthropic uses input_tokens/output_tokens; OpenAI uses prompt_tokens/
    // completion_tokens with cached reads nested under prompt_tokens_details.
    const details = (usage["prompt_tokens_details"] ?? {}) as Record<string, number>;

    return {
      model,
      usage: {
        inputTokens: usage["input_tokens"] ?? usage["prompt_tokens"] ?? 0,
        outputTokens: usage["output_tokens"] ?? usage["completion_tokens"] ?? 0,
        cacheWriteTokens: usage["cache_creation_input_tokens"] ?? 0,
        cacheReadTokens:
          usage["cache_read_input_tokens"] ?? details["cached_tokens"] ?? 0,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Accumulates usage across a Server-Sent Events stream.
 *
 * Anthropic reports input/cache tokens on `message_start` and the running
 * output count on each `message_delta` — the last delta wins rather than
 * summing, because the field is cumulative, not incremental.
 */
class StreamUsageCollector {
  model = "";
  usage: TokenUsage = { ...EMPTY_USAGE };
  private buffer = "";

  push(chunk: string): void {
    this.buffer += chunk;

    // Keep the trailing partial line in the buffer for the next chunk.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      this.consume(payload);
    }
  }

  private consume(payload: string): void {
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      const type = event["type"];

      if (type === "message_start") {
        const message = event["message"] as Record<string, unknown> | undefined;
        if (typeof message?.["model"] === "string") this.model = message["model"];
        const u = message?.["usage"] as Record<string, number> | undefined;
        if (u) {
          this.usage.inputTokens = u["input_tokens"] ?? 0;
          this.usage.cacheWriteTokens = u["cache_creation_input_tokens"] ?? 0;
          this.usage.cacheReadTokens = u["cache_read_input_tokens"] ?? 0;
          this.usage.outputTokens = u["output_tokens"] ?? 0;
        }
        return;
      }

      if (type === "message_delta") {
        const u = event["usage"] as Record<string, number> | undefined;
        if (u && typeof u["output_tokens"] === "number") {
          this.usage.outputTokens = u["output_tokens"];
        }
        return;
      }

      // OpenAI-style: usage arrives on the final chunk when the caller sets
      // stream_options: { include_usage: true }.
      if (typeof event["model"] === "string" && event["usage"]) {
        this.model ||= event["model"];
        const u = event["usage"] as Record<string, number>;
        const details = (u["prompt_tokens_details"] ?? {}) as Record<string, number>;
        this.usage.inputTokens = u["prompt_tokens"] ?? this.usage.inputTokens;
        this.usage.outputTokens = u["completion_tokens"] ?? this.usage.outputTokens;
        this.usage.cacheReadTokens = details["cached_tokens"] ?? this.usage.cacheReadTokens;
      }
    } catch {
      // A malformed event is not worth failing the request over.
    }
  }
}

/** Requests larger than this are refused rather than buffered into memory. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request body without assuming it's small enough to trust blindly. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body exceeds 64MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Resolve the upstream URL for a request.
 *
 * SECURITY: the request target must never be able to choose the host. Passing
 * `req.url` straight to `new URL(url, base)` looks right but is not — an
 * absolute target ("http://host/p") or a protocol-relative one ("//host/p")
 * overrides the base entirely, and since we forward the caller's credentials
 * verbatim, that turns the proxy into a relay that leaks API keys to any host
 * named in the path. Take only the path and query; the origin is ours alone.
 */
export function resolveTarget(rawUrl: string, upstream: string): URL {
  // A throwaway opaque base: whatever authority the target tries to smuggle in
  // is resolved against this and then discarded with it.
  const requested = new URL(rawUrl || "/", "http://request.invalid");

  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/+$/, "");

  const target = new URL(base.origin);
  target.pathname = prefix + requested.pathname;
  target.search = requested.search;
  return target;
}

function perRequestContext(
  req: IncomingMessage,
  base: AttributionContext,
): AttributionContext {
  const header = (name: string): string | null => {
    const v = req.headers[CONTROL_PREFIX + name];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    repo: header("repo") ?? base.repo,
    branch: header("branch") ?? base.branch,
    tag: header("tag") ?? base.tag,
  };
}

export function startProxy(opts: ProxyOptions): Promise<void> {
  const baseContext = resolveContext();
  let budgetWarned = false;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Surface the failure to the caller rather than hanging their request.
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({
          error: {
            type: "tokenmeter_proxy_error",
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const ctx = perRequestContext(req, baseContext);
    const body = await readBody(req);

    const target = resolveTarget(req.url ?? "/", opts.upstream);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower.startsWith(CONTROL_PREFIX)) continue;
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }

    const upstreamRes = await fetch(target, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      redirect: "manual",
    });

    // Mirror status and headers back to the caller untouched.
    const outHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    });
    res.writeHead(upstreamRes.status, outHeaders);

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream");

    let model = "";
    let usage: TokenUsage = { ...EMPTY_USAGE };

    if (!upstreamRes.body) {
      res.end();
    } else if (isStream) {
      const collector = new StreamUsageCollector();
      const decoder = new TextDecoder();
      const reader = upstreamRes.body.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Forward first — metering must never delay or alter the stream.
        res.write(Buffer.from(value));
        try {
          collector.push(decoder.decode(value, { stream: true }));
        } catch {
          /* metering only */
        }
      }
      res.end();
      model = collector.model;
      usage = collector.usage;
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
      const parsed = parseUsageFromJson(buf.toString("utf8"));
      if (parsed) {
        model = parsed.model;
        usage = parsed.usage;
      }
    }

    // A response with no usage block (an error, a non-messages endpoint) is
    // not spend — don't write a zero row that dilutes the averages.
    if (!model && usage.inputTokens === 0 && usage.outputTokens === 0) return;

    const record: CallRecord = {
      ts: started,
      provider: opts.provider,
      model: model || "unknown",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: costOf(model, usage),
      uncachedCostUsd: uncachedCostOf(model, usage),
      latencyMs: Date.now() - started,
      streamed: isStream ? 1 : 0,
      status: upstreamRes.status,
      repo: ctx.repo,
      branch: ctx.branch,
      tag: ctx.tag,
    };

    try {
      insertCall(opts.db, record);
    } catch (err) {
      process.stderr.write(
        `tokenmeter: failed to record call: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    if (opts.verbose) {
      const cached = record.cacheReadTokens > 0 ? ` cache:${record.cacheReadTokens}` : "";
      process.stderr.write(
        `  ${record.model}  in:${record.inputTokens} out:${record.outputTokens}${cached}  ` +
          `${fmtUsd(record.costUsd)}  ${record.latencyMs}ms\n`,
      );
    }

    if (opts.dailyBudget > 0) {
      const today = totalsSince(opts.db, startOfToday());
      if (today.costUsd >= opts.dailyBudget && !budgetWarned) {
        budgetWarned = true;
        process.stderr.write(
          `\n  ⚠  Daily budget exceeded: ${fmtUsd(today.costUsd)} of ` +
            `${fmtUsd(opts.dailyBudget)} across ${today.calls} calls.\n\n`,
        );
      }
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${opts.port}`;
      process.stderr.write(
        `\n  tokenmeter is measuring ${opts.upstream}\n\n` +
          `  Point your app at it:\n` +
          `    export ${envVarFor(opts.provider)}=${base}\n\n` +
          `  Then in another terminal:  tokenmeter report\n` +
          `  Stop with Ctrl-C.\n\n`,
      );
    });

    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export function envVarFor(provider: string): string {
  return provider === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL";
}

/**
 * Attribution context — which repo and branch a call should be charged to.
 *
 * Resolved once when the proxy starts, from the directory it was launched in.
 * Callers can override per-request with an `x-tokenmeter-tag` header, which is
 * how you separate "the eval suite" from "the chat endpoint" inside one repo.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface AttributionContext {
  repo: string | null;
  branch: string | null;
  tag: string | null;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

export function resolveContext(cwd: string = process.cwd()): AttributionContext {
  const envRepo = process.env["TOKENMETER_REPO"];
  const envBranch = process.env["TOKENMETER_BRANCH"];
  const envTag = process.env["TOKENMETER_TAG"];

  const toplevel = git(["rev-parse", "--show-toplevel"], cwd);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);

  return {
    repo: envRepo ?? (toplevel ? basename(toplevel) : null),
    branch: envBranch ?? (branch && branch !== "HEAD" ? branch : null),
    tag: envTag ?? null,
  };
}

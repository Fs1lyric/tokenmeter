# tokenmeter

**Know where your LLM spend goes.** A local proxy that attributes every token to a model, repo, branch, and feature — then tells you what prompt caching is actually saving you.

No account. No dashboard to log into. No data leaves your machine.

```
  $20.70 over 7d
  924 calls · 1.54M in · 697.4K out
  Prompt caching saved $24.77 (54% off $45.47 uncached)

  ▄▆▇▇▇█▆▅  2026-09-04 → 2026-09-11

  By tag
  TAG           COST  SHARE  CALLS      IN     OUT
  chat-api    $15.34    74%    529  865.2K  404.5K
  eval-suite   $4.03    19%    153  245.1K  112.1K
  classifier   $1.33     6%    242  426.6K  180.7K
```

---

## Why

Token cost volatility is the **#1 reported pain point** with AI coding tools. The provider dashboard gives you one number for the whole org, a day late. It can't tell you that your eval suite is 19% of the bill, or that the branch you merged last Tuesday tripled your input tokens.

tokenmeter answers the question the invoice can't: **which part of my code is spending the money.**

## Install

```bash
npm install -g @fs1lyric/tokenmeter
```

Requires Node 24+ (uses the built-in SQLite module). **Zero runtime dependencies.**

The command is `tokenmeter`; only the package is scoped.

## Use

Start the proxy:

```bash
tokenmeter proxy
```

Point your app at it — this is the only change you make:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

Run your app normally. Then:

```bash
tokenmeter report
```

That's the whole workflow. No SDK to import, no code to wrap, no decorators. Because it's a proxy, it works with **any language and any SDK** — Python, TypeScript, Go, curl, whatever.

## Commands

| Command | What it does |
|---|---|
| `tokenmeter proxy` | Start the measuring proxy |
| `tokenmeter report` | Spend, summarised and grouped |
| `tokenmeter tail` | The most recent calls, live |
| `tokenmeter baseline save` | Record current cost-per-call as a baseline |
| `tokenmeter ci` | Compare against the baseline; exit 1 on regression |
| `tokenmeter models` | Known models and their prices |
| `tokenmeter prune` | Delete old records |
| `tokenmeter where` | Print the data directory |

### Grouping

```bash
tokenmeter report --by model      # which model costs most
tokenmeter report --by branch     # did that branch blow up the bill
tokenmeter report --by tag        # eval suite vs production path
tokenmeter report --by day        # trend
tokenmeter report --since 24h
tokenmeter report --json          # for CI
```

### Budgets

```bash
tokenmeter proxy --budget 5
```

Prints a warning to stderr once the day's spend crosses $5. Useful when you kick off an agent loop and walk away.

### Attribution

Repo and branch come from git automatically, read from wherever you started the proxy.

To split spend *within* one repo, tag individual requests:

```
x-tokenmeter-tag: eval-suite
```

Or set it per process:

```bash
TOKENMETER_TAG=nightly-eval python run_evals.py
```

This is how you find out that 19% of your bill is a test suite nobody remembers scheduling.

## Cost regression testing in CI

Stop a PR that quietly triples your inference bill.

On `main`, after running your evals through the proxy:

```bash
tokenmeter baseline save --since 1h --tag evals
git add .tokenmeter-baseline.json && git commit -m "chore: record cost baseline"
```

On a PR branch, after the same run:

```bash
tokenmeter ci --max-increase 10%
```

```
  METRIC                BASELINE  CURRENT  CHANGE
  cost / call            $0.0105  $0.0150  +42.9%
  input tokens / call       1.0K     1.6K  +60.0%
  output tokens / call       500      500    0.0%
  cache hit rate               0%       0%      —

  20 calls this run · 20 in the baseline

  FAIL  Cost regression detected.
        Cost per call rose 42.9%, over the 10% threshold.
```

Exit code `1`. The build fails.

**The metric is cost *per call*, not total cost.** Total cost moves whenever you add a test case, which makes it useless as a gate — adding coverage would look like a regression. Cost per call isolates the thing you actually control.

### Gates

| Flag | Fails when |
|---|---|
| `--max-increase 10%` | Cost per call rose more than 10% |
| `--max-cost-per-call 0.05` | Any run exceeds $0.05 per call, regardless of baseline |
| `--max-cache-drop 50%` | Cache hit rate fell by more than half |
| `--min-calls 20` | Fewer than 20 calls recorded — catches a run where the proxy saw no traffic |

`--max-cache-drop` deserves its own gate. A broken prompt prefix can crater your hit rate while cost per call barely moves — cheap cached tokens silently repriced as expensive fresh ones. It looks fine until traffic scales:

```
  cost / call             $0.015   $0.016   +4.7%     ← gate passes
  cache hit rate             88%      16%  -81.9%     ← the actual problem
```

Without the flag that's a warning. With it, it fails the build.

### GitHub Actions

```yaml
name: cost
on: pull_request

jobs:
  cost-regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - run: npm install -g @fs1lyric/tokenmeter

      - name: Start the meter
        run: |
          tokenmeter proxy &
          sleep 1

      - name: Run evals through it
        env:
          ANTHROPIC_BASE_URL: http://127.0.0.1:8787
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          TOKENMETER_TAG: evals
        run: npm run evals

      - name: Check for cost regression
        run: tokenmeter ci --max-increase 10% --min-calls 20
```

Each CI run starts with an empty database, so the window only ever contains that run's calls. Use `--json` if you'd rather post the verdict as a PR comment than fail the build.

## Providers

| Provider | Status |
|---|---|
| Anthropic | Full support — streaming, non-streaming, prompt caching |
| OpenAI | Usage capture (set `--provider openai`; pass `stream_options: {include_usage: true}` for streamed calls) |

Any OpenAI-compatible endpoint works with `--upstream`.

## Prices

Bundled prices are current as of **2026-09-11**. To correct or extend them, drop a file at `~/.tokenmeter/pricing.json`:

```json
{
  "claude-opus-5": { "input": 5.0, "output": 25.0 },
  "my-finetune": { "input": 1.5, "output": 6.0 }
}
```

Models with no price on file are counted as `$0` and **flagged in the report**, so missing spend is visible rather than silent.

## Privacy

This is the part that matters for a tool that sits in front of your API key.

- **Your API key is forwarded and never stored, logged, or inspected.**
- **Prompts and completions are never read or written.** Only token counts, model ids, and timing.
- Everything lives in one SQLite file at `~/.tokenmeter/usage.db`. Run `tokenmeter where` to find it, delete it whenever you like.
- The tool makes no network requests of its own. No telemetry, no phone-home, no update check.

The proxy binds to `127.0.0.1` only.

## How it works

```
your app  ──►  tokenmeter  ──►  api.anthropic.com
                    │
                    └──►  ~/.tokenmeter/usage.db
```

Requests are forwarded byte-for-byte. On the way back, tokenmeter reads the `usage` block — from the JSON body for normal calls, or from the `message_start` / `message_delta` events for streamed ones — and writes a row.

Two invariants the proxy holds:

1. **Bytes go through first, metering second.** Your stream is never delayed or altered by the accounting.
2. **A metering failure never breaks a request.** Every parse is wrapped; a bad price table or a malformed event costs you a data point, not a response.

## Development

```bash
npm install
npm run build
npm test
```

Two suites, no test framework:

- `test/smoke.mjs` stands up a fake upstream, runs the real proxy against it, and asserts recorded cost against hand-computed figures — including the cache-write (1.25x) and cache-read (0.1x) multipliers.
- `test/ci.mjs` simulates the real CI shape: a baseline recorded on one machine, the PR run measured on a fresh one, then asserts the exit codes.

## Roadmap

- `tokenmeter watch` — live TUI
- PR comment output for the CI verdict
- Team sync (opt-in, self-hostable) — the only thing that would ever touch the network

## License

MIT

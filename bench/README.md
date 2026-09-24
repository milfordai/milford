# Latency budget

Part of MIL-73 ("Measure where a decision's time goes and set a latency budget").
This gate exists so a pull request that quietly slows down a decision gets caught,
noticed after release.

## What is measured today (2 of 5 layers)

| Layer | What it is | Flow | p50 | p95 | p99 |
| --- | --- | --- | ---: | ---: | ---: |
| 1. Engine in-process | Milford's own per-run cost: flow start, one `decision` node, one `output`, instant fake provider, no I/O | `f1` (1 decision) | 3 µs | 3 µs | 6 µs |
| 1. Engine in-process | same, but 4 decisions in parallel | `f4` (4 decisions) | 6 µs | 7 µs | 11 µs |
| 2. HTTP round trip | keep-alive client on localhost calling `POST /v1/flows/f/run`, sequential | one decision | 61 µs | 89 µs | 137 µs |

Numbers are the best of 3 runs on the baseline machine below; `bench/engine.mjs`
printed the same shapes as before ("about 3 to 6 µs per engine run, about 66 to 69 µs
p50 for the HTTP round trip"); best-of-3 just picks the fastest repetition, which is
the fair comparison for a gate on noisy machines.

Layers 3-5 of MIL-73 are **not measured yet**: provider transport over loopback,
a real model server, and tokenization. Their budgets come later; nothing in this gate
covers them today.

## Baseline machines

`bench/baseline.json` keeps one section per platform (`darwin-arm64`, `linux-x64`, ...),
each recording the machine, Node version and metrics it was generated on. The gate
compares a machine only against its own platform's section, so a slower CI runner never
judges itself against an M4 Pro.

- `darwin-arm64`: Apple M4 Pro, `node v25.9.0` (the numbers in the table above)
- `linux-x64`: not recorded yet — the first `perf` CI run fails with its own numbers
  printed; paste them into the `linux-x64` section (or rerun `--update-baseline` on such
  a machine) and commit, and every later run gates properly.

## How to run

```sh
pnpm build          # required once; the bench never builds for you
node bench/engine.mjs   # engine cost, standalone (for humans)
node bench/http.mjs     # HTTP round trip, standalone (for humans)
node bench/run.mjs      # the gate: best-of-3 vs baseline, exit 1 on regression
pnpm bench              # same as `node bench/run.mjs`, from the repo root
```

## How the gate works

`bench/run.mjs` runs both benchmarks 5 times, keeps the best (fastest) value per
metric, and compares every `p95` metric against this platform's section in
`bench/baseline.json`. A metric that moved more than **+10%** above baseline fails the
gate (exit 1) and is listed with its number; `p50`/`p99`/`mean` are reported in the
table but do not gate. A gated metric with no baseline entry also fails, so a new
measurement cannot slip through ungated; a platform with no recorded section fails the
same way, with its own numbers printed, so a new platform gets recorded instead of
passing ungated. A missing `packages/*/dist` fails fast with a "run `pnpm build`"
message.

In CI (`.github/workflows/ci.yml`, `perf` job) the gate runs on every push to `main`
and `dev` and on every pull request, right after `pnpm build`.

A busy desktop — browser, editors, video calls — fattens `p95` by about 10 percent
on its own. A local `Gate: FAIL` where `p50` is unchanged usually means background
load, not a regression; rerun on an idle machine before touching the baseline. The
enforcing gate is the isolated CI `perf` job, and `p50` is the anchor that tells the
two apart.

## Updating the baseline deliberately

Only do this when the change is expected (a faster engine, new flow shapes, a new
machine) and the regression on the PR is genuinely acceptable:

```sh
node bench/run.mjs --update-baseline
```

This rewrites **this platform's section** of `bench/baseline.json` from today's
best-of-3 on the current machine and leaves every other platform's section untouched.
Commit the new baseline together with the change that justifies it.

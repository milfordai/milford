// Latency gate: runs the engine and HTTP benchmarks a few times, keeps the best (fastest)
// value per metric, and compares p95 against this platform's section in bench/baseline.json.
// Baselines are per platform — an M4 Pro number says nothing about a CI x64 runner — so a
// machine is only ever judged against its own section.
// Fails (exit 1) when a p95 metric regresses more than 10% vs baseline, listing each regression.
// Usage:
//   node bench/run.mjs                     run the gate
//   node bench/run.mjs --update-baseline   record today's numbers as this platform's baseline
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";

const DIST_CORE = fileURLToPath(new URL("../packages/core/dist/index.js", import.meta.url));
const DIST_SERVER = fileURLToPath(new URL("../packages/server/dist/index.js", import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL("./baseline.json", import.meta.url));

// p95 is the gated metric; the other percentiles are reported for the latency budget.
const GATE_SUFFIX = ".p95";
const REGRESSION_PERCENT = 10;
const ROUNDS = 5; // best-of-N: a busy dev machine or CI runner fattens the tail; the fastest clean round wins.

// The bench/baseline.json section this machine compares against, e.g. "darwin-arm64".
const PLATFORM_KEY = `${os.platform()}-${os.arch()}`;

// The benches import the built packages, so check dist first with a clear message instead
// of letting the import fail cryptically.
function checkDist() {
  const missing = [DIST_CORE, DIST_SERVER].filter((f) => !existsSync(f));
  if (missing.length > 0) {
    console.error(`Benchmark inputs are missing (${missing.join(", ")}).`);
    console.error("Run `pnpm build` first, then retry. The bench never builds for you on purpose.");
    process.exit(1);
  }
}

// bench/baseline.json keeps one section per platform:
// { platforms: { "darwin-arm64": { machine, node, generatedAt, metrics } } }.
function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return { platforms: {} };
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

// Runs both benchmarks ROUNDS times and returns the best (lowest) value per metric key.
async function bestOf({ measureEngine, measureHttp }) {
  const best = {};
  for (let i = 0; i < ROUNDS; i++) {
    const rows = [...(await measureEngine()), ...(await measureHttp())];
    for (const row of rows) {
      for (const [metric, value] of Object.entries(row)) {
        if (metric === "layer" || metric === "case") continue;
        const key = `${row.layer}.${row.case}.${metric}`;
        if (best[key] === undefined || value < best[key]) best[key] = value;
      }
    }
  }
  return best;
}

function printTable(current, baselineMetrics) {
  const keys = Object.keys(current).sort();
  const width = Math.max(...keys.map((k) => k.length));
  console.log("metric".padEnd(width) + "  baseline  current   delta  status");
  for (const key of keys) {
    const value = current[key];
    const prev = baselineMetrics?.[key];
    let delta = "   —   ";
    let status = "no baseline";
    if (prev !== undefined) {
      const pct = ((value - prev) / prev) * 100;
      delta = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`.padEnd(7);
      status = key.endsWith(GATE_SUFFIX) && pct > REGRESSION_PERCENT ? "REGRESSION" : "ok";
    }
    console.log(key.padEnd(width) + `  ${String(prev ?? "—").padStart(8)}  ${String(value).padStart(7)}  ${delta}  ${status}`);
  }
}

checkDist();
const { measureEngine } = await import("./engine.mjs");
const { measureHttp } = await import("./http.mjs");
const isUpdate = process.argv.includes("--update-baseline");
const current = await bestOf({ measureEngine, measureHttp });

if (isUpdate) {
  const baseline = readBaseline();
  const machine = os.cpus()[0]?.model ?? PLATFORM_KEY;
  baseline.platforms[PLATFORM_KEY] = {
    machine,
    node: process.version,
    generatedAt: new Date().toISOString(),
    metrics: Object.fromEntries(Object.keys(current).sort().map((k) => [k, current[k]])),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Baseline for ${PLATFORM_KEY} written to bench/baseline.json (best of ${ROUNDS} on ${machine}, node ${process.version}).`);
  console.log("Other platforms' sections were left untouched; the gate only compares a machine against its own.");
  printTable(current, baseline.platforms[PLATFORM_KEY].metrics);
  process.exit(0);
}

const baseline = readBaseline();
const section = baseline.platforms?.[PLATFORM_KEY];
if (!section) {
  printTable(current, undefined);
  console.error(`No baseline recorded for ${PLATFORM_KEY} in bench/baseline.json.`);
  console.error("The current column above is this machine's best-of-3; commit it as this platform's section:");
  console.error("run `node bench/run.mjs --update-baseline` on this platform, or paste the numbers from the table.");
  process.exit(1);
}

const baselineMetrics = section.metrics;
printTable(current, baselineMetrics);

const regressions = [];
for (const [key, value] of Object.entries(current)) {
  if (!key.endsWith(GATE_SUFFIX)) continue;
  const prev = baselineMetrics[key];
  if (prev === undefined) {
    regressions.push(`${key}: gated metric has no baseline entry — regenerate with --update-baseline`);
    continue;
  }
  const pct = ((value - prev) / prev) * 100;
  if (pct > REGRESSION_PERCENT) {
    regressions.push(`${key}: baseline ${prev} µs, now ${value} µs (+${pct.toFixed(1)}%) — exceeds the +${REGRESSION_PERCENT}% budget`);
  }
}

if (regressions.length > 0) {
  console.error(`\nGate: FAIL (${regressions.length} regression${regressions.length > 1 ? "s" : ""})`);
  for (const r of regressions) console.error(`  ${r}`);
  process.exit(1);
}

console.log(`\nGate: PASS — every p95 stays within +${REGRESSION_PERCENT}% of the ${PLATFORM_KEY} baseline (best of ${ROUNDS}).`);

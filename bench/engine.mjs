// Milford's own cost per run: an instant stand-in provider, so nothing but the engine is measured.
// Run after `pnpm -r build`: node bench/engine.mjs
// bench/run.mjs imports measureEngine() to compare against the latency baseline.
import { pathToFileURL } from "node:url";
import { createEngine, defaultRegistry } from "../packages/core/dist/index.js";

// A provider that answers instantly, so what is measured is Milford's own overhead.
const fast = { id: "p", type: "fast", capabilities: ["decide"], decide: async (r) => ({ ok: true, value: { kind: "choice", choice: r.options[0], confidence: 0.9 } }) };
const registry = defaultRegistry().registerProvider("fast", () => ({ ok: true, value: fast }));
const flow = (n) => ({
  id: `f${n}`,
  nodes: [{ id: "in", type: "input" }, ...Array.from({ length: n }, (_, i) => ({ id: `d${i}`, type: "decision", config: { provider: "p", kind: "choice", prompt: "Which?", options: ["a", "b", "c"], state: "T: {{input.t}} H: {{input.h}}" } })), { id: "out", type: "output" }],
  edges: [...Array.from({ length: n }, (_, i) => ({ from: "in", to: `d${i}` })), ...Array.from({ length: n }, (_, i) => ({ from: `d${i}`, to: "out" }))],
});
const e = createEngine({ registry, providers: [{ id: "p", type: "fast" }], flows: [flow(1), flow(4)] });
if (!e.ok) throw new Error(e.error);

// Measures Milford's own per-run cost in microseconds for the f1 and f4 flows.
// Returns one row per flow: { layer: "engine", case, p50, p95, p99, mean }.
// Warmup and sample counts are part of the measured contract; keep them stable.
export async function measureEngine() {
  const rows = [];
  for (const id of ["f1", "f4"]) {
    for (let i = 0; i < 2000; i++) await e.value.run(id, { t: 23.4, h: 61.2 }); // warm up
    const N = 20000, lat = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); await e.value.run(id, { t: 23.4, h: 61.2 }); lat.push(performance.now() - t0); }
    lat.sort((a, b) => a - b);
    const q = (p) => Math.round(lat[Math.floor(p * N)] * 1000);
    rows.push({ layer: "engine", case: id, p50: q(0.5), p95: q(0.95), p99: q(0.99), mean: Math.round((lat.reduce((a, b) => a + b, 0) / N) * 1000) });
  }
  return rows;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rows = await measureEngine();
  for (const r of rows) console.log(`${r.case}: p50 ${r.p50} µs, p95 ${r.p95} µs, p99 ${r.p99} µs, mean ${r.mean} µs`);
}

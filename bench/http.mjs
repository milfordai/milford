// Cost of the HTTP path in front of the engine: a keep-alive client on localhost calling POST /v1/flows/{id}/run.
// Run after `pnpm -r build`: node bench/http.mjs
// bench/run.mjs imports measureHttp() to compare against the latency baseline.
import { pathToFileURL } from "node:url";
import { createEngine, defaultRegistry } from "../packages/core/dist/index.js";
import { createApp } from "../packages/server/dist/index.js";
import { serve } from "../packages/server/node_modules/@hono/node-server/dist/index.mjs";
import http from "node:http";

const fast = { id: "p", type: "fast", capabilities: ["decide"], decide: async (r) => ({ ok: true, value: { kind: "choice", choice: r.options[0], confidence: 0.9 } }) };
const registry = defaultRegistry().registerProvider("fast", () => ({ ok: true, value: fast }));
const flow = { id: "f", nodes: [{ id: "in", type: "input" }, { id: "d", type: "decision", config: { provider: "p", kind: "choice", prompt: "Which?", options: ["a", "b", "c"], state: "T: {{input.t}}" } }, { id: "out", type: "output" }], edges: [{ from: "in", to: "d" }, { from: "d", to: "out" }] };
const e = createEngine({ registry, providers: [{ id: "p", type: "fast" }], flows: [flow] });
const app = createApp({ engine: e.value, log: () => {}, runs: { save() {}, list: () => [], get: () => undefined } });

// Measures the HTTP round trip in microseconds for a keep-alive client on localhost.
// Returns one row: { layer: "http", case: "round-trip", p50, p95, p99 }.
// Warmup and sample counts are part of the measured contract; keep them stable.
export async function measureHttp() {
  const server = serve({ fetch: app.fetch, port: 18099 });
  const agent = new http.Agent({ keepAlive: true });
  try {
    await new Promise((r) => setTimeout(r, 300));

    // A keep-alive client, as a real service would use.
    const body = JSON.stringify({ input: { t: 23.4 } });
    const call = () => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: 18099, path: "/v1/flows/f/run", method: "POST", agent, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject); req.end(body);
    });
    for (let i = 0; i < 2000; i++) await call();
    const N = 10000, lat = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); await call(); lat.push(performance.now() - t0); }
    lat.sort((a, b) => a - b);
    const q = (p) => Math.round(lat[Math.floor(p * N)] * 1000);
    return [{ layer: "http", case: "round-trip", p50: q(0.5), p95: q(0.95), p99: q(0.99) }];
  } finally {
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rows = await measureHttp();
  for (const r of rows) console.log(`HTTP round trip on localhost (keep-alive, sequential): p50 ${r.p50} µs, p95 ${r.p95} µs, p99 ${r.p99} µs`);
  process.exit(0);
}

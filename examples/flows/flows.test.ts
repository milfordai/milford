import { createEngine, defaultRegistry, type Provider } from "@milford/core";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const any: Provider = {
  id: "main-llm",
  type: "fake",
  capabilities: ["chat", "decide"],
  chat: async (r) => ({ ok: true, value: { text: `summary of: ${r.prompt}` } }),
  decide: async (r) => ({ ok: true, value: { kind: "choice", choice: r.options![0], confidence: 0.9 } }),
};
const flows = readdirSync(new URL(".", import.meta.url)).filter((f) => ["hello", "summarize", "triage", "webhook"].includes(f.replace(".json", ""))).map((f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8")));
const engine = createEngine({ registry: defaultRegistry().registerProvider("fake", () => ({ ok: true, value: any })), providers: [{ id: "main-llm", type: "fake" }], flows });
if (!engine.ok) throw new Error(engine.error);

it("every example flow compiles", () => {
  expect(engine.value.flows().map((f) => f.id).sort()).toEqual(["hello", "summarize", "triage", "webhook"]);
});
it("hello, summarize and triage run", async () => {
  const run = async (id: string, input: Record<string, unknown>) => {
    const r = await engine.value.run(id, input);
    if (!r.ok) throw new Error(r.error);
    return r.value.output?.output;
  };
  expect(await run("hello", { name: "Ann" })).toBe("Hello Ann!");
  expect(await run("summarize", { text: "long text" })).toBe("summary of: long text");
  expect(await run("triage", { text: "my invoice is wrong" })).toBe("Route to billing.");
});

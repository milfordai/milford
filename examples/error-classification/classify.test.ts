import { createEngine, defaultRegistry, type DecideRequest, type Decision, type Provider } from "@milford/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const flow = JSON.parse(readFileSync(new URL("./flow.json", import.meta.url), "utf8"));

/** Keyword stand-in for a model. Anything it does not recognise gets a low-confidence guess. */
const rules: Provider = {
  id: "classifier",
  type: "rules",
  capabilities: ["decide"],
  async decide(req: DecideRequest) {
    const state = String(req.state);
    if (req.kind === "noul") {
      const [current, history = ""] = state.split("Previously recorded errors:");
      const first = current!.replace("New error:", "").trim().slice(0, 25);
      return { ok: true, value: { kind: "noul", noul: history.includes(first) ? 0.95 : 0.05 } satisfies Decision };
    }
    const pick = (choice?: string): Decision => (choice ? { kind: "choice", choice, confidence: 0.9 } : { kind: "choice", choice: req.options![0], confidence: 0.2 });
    if (/Connection refused|timed out|OutOfMemory|No space left/i.test(state)) return { ok: true, value: pick("infra-incident") };
    if (/NullPointerException|IllegalStateException/.test(state)) return { ok: true, value: pick("application-defect") };
    if (/invalid (input|request)|must not be blank/i.test(state)) return { ok: true, value: pick("user-exception") };
    return { ok: true, value: pick() };
  },
};

const engine = createEngine({ registry: defaultRegistry().registerProvider("rules", () => ({ ok: true, value: rules })), providers: [{ id: "classifier", type: "rules" }], flows: [flow] });
if (!engine.ok) throw new Error(engine.error);

const classify = async (message: string, history: string[] = [], stackTrace = "") => {
  const r = await engine.value.run("classify-error", { service: "payments", message, stackTrace, history });
  if (!r.ok || !r.value.ok) throw new Error("run failed");
  const d = r.value.output!.data as { category: { choice: string; confidence: number }; duplicate: { noul: number } };
  return { category: d.category.choice, confidence: d.category.confidence, duplicate: d.duplicate.noul, text: r.value.output!.output };
};

describe("classify-error", () => {
  it("classifies infra incidents, application defects and user exceptions", async () => {
    expect((await classify("Connection refused: db-primary:5432")).category).toBe("infra-incident");
    expect((await classify("boom", [], "java.lang.NullPointerException at OrderService.java:88")).category).toBe("application-defect");
    expect((await classify("invalid input: amount must not be blank")).category).toBe("user-exception");
  });

  it("recognises an error that was seen before", async () => {
    const message = "Connection refused: db-primary:5432";
    expect((await classify(message, [message])).duplicate).toBeGreaterThan(0.5);
    expect((await classify(message, ["Some unrelated failure"])).duplicate).toBeLessThan(0.5);
    expect((await classify(message, [])).duplicate).toBeLessThan(0.5);
  });

  it("sends unclear errors to a human instead of guessing", async () => {
    const r = await classify("something odd happened");
    expect(r.category).toBe("none_of_these");
    expect(r.text).toContain("category=none_of_these");
  });
});

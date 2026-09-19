import { createEngine, defaultRegistry, type DecideRequest, type Decision, type Provider } from "@loage/core";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeDevices } from "./fake-devices.ts";

const flow = JSON.parse(readFileSync(new URL("./flow.json", import.meta.url), "utf8"));
const home = JSON.parse(readFileSync(new URL("./devices.json", import.meta.url), "utf8")) as { rooms: string[]; devices: string[] };

/** Keyword-driven stand-in for a decision model. Unknown things get a low-confidence guess. */
const rules: Provider = {
  id: "rules",
  type: "rules",
  capabilities: ["decide"],
  async decide(req: DecideRequest) {
    const s = String(req.state).toLowerCase();
    const q = req.prompt.toLowerCase();
    const opts = req.options!;
    const pick = (hit: string | undefined): Decision => (hit ? { kind: "choice", choice: hit, confidence: 0.9 } : { kind: "choice", choice: opts[0], confidence: 0.1 });
    if (q.includes("which room")) return { ok: true, value: pick(s.includes("whole house") ? "whole-house" : opts.find((o) => s.includes(o.replace("-", " ")))) };
    if (q.includes("which device")) return { ok: true, value: pick(s.includes("coffee") ? "coffee-machine" : s.includes("lock") ? "front-door-lock" : s.includes("light") ? "kitchen-lamp" : undefined) };
    if (q.includes("kind of device")) return { ok: true, value: pick(s.includes("coffee") ? "appliances" : s.includes("lock") ? "locks" : s.includes("light") ? "lights" : undefined) };
    // Action questions: "What should happen to the <class>?"
    const off = /\b(off|lock up|close)\b/.test(s);
    return { ok: true, value: pick(q.includes("locks") ? (off ? "locked" : "unlocked") : off ? "off" : "on") };
  },
};

let devices: Awaited<ReturnType<typeof startFakeDevices>>;
beforeAll(async () => (devices = await startFakeDevices(0)));
afterAll(() => devices.server.close());

const run = async (command: string) => {
  devices.calls.length = 0;
  const e = createEngine({ registry: defaultRegistry().registerProvider("rules", () => ({ ok: true, value: rules })), providers: [{ id: "jev", type: "rules" }], flows: [flow] });
  if (!e.ok) throw new Error(e.error);
  const r = await e.value.run("home", { command, homeUrl: devices.url, ...home });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("home automation", () => {
  it("turns a free-text command into one device call", async () => {
    const r = await run("Get the coffee boiling in the kitchen");
    expect(r.ok).toBe(true);
    expect(devices.calls).toEqual([{ device: "coffee-machine", body: { device: "coffee-machine", room: "kitchen", action: "on" } }]);
    // The trace carries every decision, so a UI can render it.
    expect(r.nodes["class"]?.result?.data).toMatchObject({ choice: "appliances", confidence: 0.9 });
    expect(r.nodes["call-lights"]?.status).toBe("skipped");
  });

  it("locks up the whole house", async () => {
    await run("Lock up the whole house");
    expect(devices.calls).toEqual([{ device: "front-door-lock", body: { device: "front-door-lock", room: "whole-house", action: "locked" } }]);
  });

  it("turns lights off", async () => {
    await run("Turn off the kitchen lights");
    expect(devices.calls[0]?.body).toEqual({ device: "kitchen-lamp", room: "kitchen", action: "off" });
  });

  it("rejects off-topic questions without touching a device", async () => {
    const r = await run("Who won the World Series in 1989?");
    expect(devices.calls).toEqual([]);
    expect(r.output?.output).toContain("not something I can do");
  });

  it("asks for clarification when the room is unclear", async () => {
    const r = await run("Turn on the lights");
    expect(devices.calls).toEqual([]);
    expect(r.output?.output).toContain("Which room and device");
  });
});

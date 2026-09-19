// Generates flow.json with the TypeScript builder: `pnpm flow`.
import { flow } from "@milford/core";

const classes: Record<string, { actions: string[]; noun: string }> = {
  lights: { actions: ["on", "off"], noun: "lights" },
  fans: { actions: ["on", "off"], noun: "fans" },
  locks: { actions: ["locked", "unlocked"], noun: "locks" },
  appliances: { actions: ["on", "off"], noun: "appliances" },
  speakers: { actions: ["on", "off"], noun: "speakers" },
  thermostats: { actions: ["warmer", "cooler"], noun: "thermostats" },
};
const NONE = "none_of_these";
const p = "jev"; // provider id from milford.config.yaml; any provider that can decide works.

const f = flow("home")
  .node("in", "input")
  .node("room", "decision", { provider: p, kind: "choice", prompt: "Which room does the user mean?", options: "{{input.rooms}}", state: "{{input.command}}", minConfidence: 0.5 })
  .node("device", "decision", { provider: p, kind: "choice", prompt: "Which device does the user mean?", options: "{{input.devices}}", state: "{{input.command}}", minConfidence: 0.5 })
  .node("class", "decision", { provider: p, kind: "choice", prompt: "Which kind of device does the user want to control?", options: Object.keys(classes), state: "{{input.command}}", minConfidence: 0.6 })
  .node("noop", "prompt", { template: "That is not something I can do at home." })
  .node("clarify", "prompt", { template: "Which room and device do you mean?" })
  .node("out", "output")
  .edge("in", "room").edge("in", "device").edge("in", "class")
  .edge("class", "noop", { path: "data.choice", op: "eq", value: NONE })
  .edge("room", "clarify", { path: "data.choice", op: "eq", value: NONE })
  .edge("device", "clarify", { path: "data.choice", op: "eq", value: NONE })
  .edge("noop", "out").edge("clarify", "out");

for (const [name, { actions, noun }] of Object.entries(classes)) {
  // All action questions run speculatively in parallel; only the matching class is used.
  f.node(`act-${name}`, "decision", { provider: p, kind: "choice", prompt: `What should happen to the ${noun}?`, options: actions, state: "{{input.command}}", minConfidence: 0.5 })
    .edge("in", `act-${name}`);
  // join "all": the class matched, the action is known, and the room and device were understood.
  f.node(`call-${name}`, "http", { url: "{{input.homeUrl}}/devices/{{device}}", method: "POST", body: { device: "{{device}}", room: "{{room}}", action: `{{act-${name}}}` } }, { join: "all" })
    .edge("class", `call-${name}`, { path: "data.choice", op: "eq", value: name })
    .edge(`act-${name}`, `call-${name}`, { path: "data.choice", op: "neq", value: NONE })
    .edge("room", `call-${name}`, { path: "data.choice", op: "neq", value: NONE })
    .edge("device", `call-${name}`, { path: "data.choice", op: "neq", value: NONE })
    .edge(`call-${name}`, "out");
}

console.log(JSON.stringify(f.build(), null, 2));

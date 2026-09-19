import { expect, it } from "vitest";
import type { Result } from "./index.js";

it("narrows Result", () => {
  const r: Result<number> = { ok: true, value: 1 };
  expect(r.ok && r.value).toBe(1);
});

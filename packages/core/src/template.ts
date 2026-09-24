import type { NodeResult, Result } from "./types.js";

export type Scope = Record<string, unknown>;

/** Scope for templates: run input under `input`, and each upstream node's result under its id. */
export const scopeOf = (input: Record<string, unknown>, upstream: Record<string, NodeResult>): Scope => ({ ...upstream, input });

const isResult = (value: unknown): value is NodeResult => typeof value === "object" && value !== null && "success" in value;

/** Resolves a dotted path. A bare node id resolves to that node's `output`. */
export function resolve(path: string, scope: Scope): unknown {
  const value = path.split(".").reduce<any>((acc, key) => acc?.[key], scope);
  return isResult(value) ? value.output : value;
}

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** Fills `{{path}}` placeholders. Unknown variables are an error, not an empty string. */
export function render(template: string, scope: Scope): Result<string> {
  let missing: string | undefined;
  const output = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
    const value = resolve(path, scope);
    if (value === undefined) missing ??= path;
    return value === undefined ? "" : show(value);
  });
  return missing ? { ok: false, error: `unknown template variable "${missing}"` } : { ok: true, value: output };
}

/** Renders every string inside a JSON-like value. A string that is exactly one `{{path}}` keeps the raw value (array, number, ...). */
export function renderDeep(value: unknown, scope: Scope): Result<unknown> {
  if (typeof value === "string") {
    const path = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/)?.[1];
    if (path === undefined) return render(value, scope);
    const resolved = resolve(path, scope);
    return resolved === undefined ? { ok: false, error: `unknown template variable "${path}"` } : { ok: true, value: resolved };
  }

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const result = renderDeep(item, scope);
      if (!result.ok) return result;
      output.push(result.value);
    }
    return { ok: true, value: output };
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = renderDeep(item, scope);
      if (!result.ok) return result;
      output[key] = result.value;
    }
    return { ok: true, value: output };
  }

  return { ok: true, value };
}

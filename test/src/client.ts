/** JSON helpers for the HTTP contract tests. */

export type RunResult = {
  ok: boolean;
  runId: string;
  nodes: Record<string, { status: "done" | "error" | "skipped"; result?: { success: boolean; output?: string; data?: unknown; error?: string }; ms?: number }>;
  output?: { success: boolean; output?: string; data?: unknown; error?: string };
  cache?: "hit" | "miss";
  [key: string]: unknown;
};

export async function runFlow(
  base: string,
  flowId: string,
  input: Record<string, unknown>,
  token: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: RunResult; headers: Headers }> {
  const res = await fetch(`${base}/v1/flows/${flowId}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ input }),
  });
  return { status: res.status, body: (await res.json()) as RunResult, headers: res.headers };
}

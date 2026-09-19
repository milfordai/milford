import type { ProviderFactory } from "@loage/core";
import { z } from "zod";
import { decisionFrom, fillRequest, mapSchema } from "./mapped.js";
import { signV4 } from "./sigv4.js";
import { err } from "./util.js";

const config = z.object({
  endpoint: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  sessionToken: z.string().optional(),
  request: z.unknown().default({ prompt: "{{prompt}}", state: "{{state}}", options: "{{options}}" }),
  map: mapSchema.default({}),
});

/** `decide` through SageMaker InvokeEndpoint (SigV4 over plain fetch), sharing the `http` request/response mapping. */
export const sagemaker: ProviderFactory = (raw, { fetch }) => {
  const p = config.safeParse(raw);
  if (!p.success) return err(p.error.message);
  const c = p.data;
  const url = `https://runtime.sagemaker.${c.region}.amazonaws.com/endpoints/${encodeURIComponent(c.endpoint)}/invocations`;
  return {
    ok: true,
    value: {
      id: raw.id,
      type: "sagemaker",
      capabilities: ["decide"],
      async decide(req) {
        const body = fillRequest(c.request, req);
        if (!body.ok) return body;
        const payload = JSON.stringify(body.value);
        const headers = signV4({ method: "POST", url, headers: { "content-type": "application/json" }, body: payload, region: c.region, service: "sagemaker", creds: c });
        try {
          const res = await fetch(url, { method: "POST", headers, body: payload, signal: req.signal });
          const text = await res.text();
          if (!res.ok) return err(`HTTP ${res.status}: ${text.slice(0, 300)}`);
          return decisionFrom(req, JSON.parse(text), c.map);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
  };
};

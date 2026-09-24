import { createHmac } from "node:crypto";

/**
 * Signs an inbound webhook body the way the `webhook` channel expects: `x-milford-timestamp` (unix
 * seconds) and `x-milford-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 */
export function signWebhook(secret: string, timestamp: number, body: string): Record<string, string> {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { "x-milford-timestamp": String(timestamp), "x-milford-signature": `sha256=${signature}` };
}

/** A signed POST of `body` to a webhook endpoint. */
export async function postWebhook(url: string, secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signWebhook(secret, timestamp, body) }, body });
}

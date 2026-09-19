import { createHash, createHmac } from "node:crypto";

export type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();

/** AWS Signature Version 4. Returns the headers to send (including Authorization). */
export function signV4(o: { method: string; url: string; headers?: Record<string, string>; body?: string; region: string; service: string; creds: AwsCreds; date?: Date }): Record<string, string> {
  const u = new URL(o.url);
  const amzDate = (o.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...o.headers, host: u.host, "x-amz-date": amzDate };
  if (o.creds.sessionToken) headers["x-amz-security-token"] = o.creds.sessionToken;

  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonical = [o.method, u.pathname, query, canonicalHeaders, signedHeaders, sha256(o.body ?? "")].join("\n");

  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.creds.secretAccessKey}`, day), o.region), o.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

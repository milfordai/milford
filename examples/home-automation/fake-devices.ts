// A fake home system so the example runs with no hardware: `pnpm devices`.
import { createServer, type Server } from "node:http";

export type DeviceCall = { device: string; body: unknown };

export function startFakeDevices(port = 9090): Promise<{ server: Server; url: string; calls: DeviceCall[] }> {
  const calls: DeviceCall[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const device = decodeURIComponent(req.url?.split("/").pop() ?? "");
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ device, body });
      console.log(`[device] ${req.method} ${req.url}`, raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, device }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, calls, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) startFakeDevices().then((d) => console.log(`fake devices on ${d.url}`));

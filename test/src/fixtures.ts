export const TOKEN = "test-token-123";

/**
 * Builds a `milford.config.yaml` for the tests. `PORT` is replaced by the harness with a free port.
 * `files` are written next to it (e.g. `flows/hello.json`).
 */
export function serverConfig(fakeUrl: string, files: Record<string, object>): { config: string; files: Record<string, string> } {
  const flows = Object.keys(files)
    .map((f) => `  - { file: ${f} }`)
    .join("\n");
  return {
    config: [
      "providers:",
      `  - { id: fake, type: openai, baseUrl: "${fakeUrl}", model: fake-model }`,
      "flows:",
      flows,
      "server:",
      "  port: PORT",
      "  auth:",
      `    tokens: ["${TOKEN}"]`,
      "  runs: { store: memory }",
    ].join("\n"),
    files: Object.fromEntries(
      Object.entries(files).map(([path, flow]) => [path, JSON.stringify(flow, null, 2)]),
    ),
  };
}

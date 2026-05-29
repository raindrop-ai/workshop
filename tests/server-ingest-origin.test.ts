import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";

const servers: Array<Awaited<ReturnType<typeof createServer>>["server"]> = [];

async function listen(): Promise<string> {
  const { server } = await createServer(0);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

describe("ingest origin boundary", () => {
  test("rejects browser ingest from non-local origins", async () => {
    const base = await listen();
    const res = await fetch(`${base}/v1/live`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({
        traceId: "driveby",
        type: "llm_output",
        content: "planted",
        timestamp: Date.now(),
      }),
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("allows browser ingest preflight from local origins", async () => {
    const base = await listen();
    const origin = "http://localhost:5173";
    const res = await fetch(`${base}/v1/traces`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  });
});

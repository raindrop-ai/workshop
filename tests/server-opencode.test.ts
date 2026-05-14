import { afterAll, beforeAll, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import request from "supertest";

let app: any;
let server: any;

beforeAll(async () => {
  process.env.RAINDROP_WORKSHOP_DB_PATH = path.join(os.tmpdir(), `workshop-server-${Date.now()}.db`);
  process.env.RAINDROP_WORKSHOP_OPENCODE_CLI_CHAT = "0";
  const mod = await import("../src/server");
  const db = await import("../src/db");
  const created = await mod.createServer(0);
  app = created.app;
  server = created.server;
  (globalThis as any).__closeDb = db.closeDb;
});

afterAll(() => {
  server?.close?.();
  (globalThis as any).__closeDb?.();
});

test("server accepts opencode as the active provider", async () => {
  const setRes = await request(app)
    .post("/api/agent/provider")
    .send({ provider: "opencode" });

  expect(setRes.status).toBe(200);
  expect(setRes.body.provider).toBe("opencode");

  const getRes = await request(app).get("/api/agent/provider");
  expect(getRes.status).toBe(200);
  expect(getRes.body.provider).toBe("opencode");
});

test("status payload exposes opencode availability", async () => {
  const res = await request(app).get("/api/status");
  expect(res.status).toBe(200);
  expect(res.body.opencode).toEqual(expect.objectContaining({ mode: "opencode_exec_stream" }));
});

test("sessions route supports the opencode provider", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app).get("/api/agent/sessions");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test("messages route returns a provider-specific 409 when opencode chat is disabled", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app)
    .post("/api/agent/messages")
    .send({ content: "hello from test", session_id: null, run_id: null, client_message_id: "msg-test" });

  expect(res.status).toBe(409);
  expect(res.body.error).toContain("OpenCode chat is disabled");
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

let app: any;
let server: any;
let originalPath: string | undefined;
let originalStateDir: string | undefined;
let originalDbPath: string | undefined;
let originalOpencodeBin: string | undefined;
let originalOpencodeCliChat: string | undefined;
let tempStateDir: string | undefined;

beforeAll(async () => {
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-opencode-state-"));
  originalStateDir = process.env.RAINDROP_WORKSHOP_STATE_DIR;
  originalDbPath = process.env.RAINDROP_WORKSHOP_DB_PATH;
  originalOpencodeBin = process.env.RAINDROP_WORKSHOP_OPENCODE_BIN;
  originalOpencodeCliChat = process.env.RAINDROP_WORKSHOP_OPENCODE_CLI_CHAT;
  process.env.RAINDROP_WORKSHOP_STATE_DIR = tempStateDir;
  process.env.RAINDROP_WORKSHOP_DB_PATH = path.join(os.tmpdir(), `workshop-server-${Date.now()}.db`);
  process.env.RAINDROP_WORKSHOP_OPENCODE_CLI_CHAT = "1";
  const binDir = path.join(os.tmpdir(), `workshop-opencode-bin-${Date.now()}`);
  fs.mkdirSync(binDir, { recursive: true });
  const opencodePath = path.join(binDir, "opencode-mock");
  fs.writeFileSync(opencodePath, `#!${process.execPath}
const cwd = process.cwd();
const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "version") {
  console.log("opencode mock 1.0.0");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  console.log(JSON.stringify([
    {
      id: "ses_mock",
      title: "Mock OpenCode Session",
      updated: 1778795844550,
      created: 1778795844497,
      directory: cwd
    },
    {
      id: "ses_resume",
      title: "Resumed OpenCode Session",
      updated: 1778795844700,
      created: 1778795844497,
      directory: cwd
    }
  ]));
  process.exit(0);
}
if (args[0] === "export") {
  const sessionId = args[1] || "ses_mock";
  const userText = sessionId === "ses_resume" ? "resume from test" : "hello from test";
  const assistantText = sessionId === "ses_resume" ? "resumed response" : "mock response";
  console.log("Exporting session: " + sessionId);
  console.log(JSON.stringify({
    info: {
      id: sessionId,
      directory: cwd,
      title: sessionId === "ses_resume" ? "Resumed OpenCode Session" : "Mock OpenCode Session",
      time: { created: 1778795844497, updated: 1778795844550 }
    },
    messages: [
      {
        info: { role: "user", id: "msg_user", time: { created: 1778795844538 } },
        parts: [{ type: "text", text: userText }]
      },
      {
        info: { role: "assistant", id: "msg_assistant", time: { created: 1778795844600 } },
        parts: [{ type: "text", text: assistantText }]
      }
    ]
  }, null, 2));
  process.exit(0);
}
if (args[0] === "run") {
  const prompt = args[args.length - 1];
  const resumeIndex = args.indexOf("--session");
  const resumeSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
  if (prompt.includes("fail from test")) {
    console.error("permission denied from opencode");
    process.exit(13);
  }
  if (prompt.includes("error event from test")) {
    console.log(JSON.stringify({
      type: "error",
      sessionID: "ses_error",
      error: { data: { message: "model unavailable from opencode" } }
    }));
    process.exit(1);
  }
  if (prompt.includes("resume from test") && resumeSessionId !== "ses_resume") {
    console.error("missing resume session");
    process.exit(9);
  }
  const sessionId = resumeSessionId || "ses_mock";
  const responseText = prompt.includes("resume from test") ? "resumed response" : "mock response";
  console.log(JSON.stringify({ type: "session.status", sessionID: sessionId, status: "working" }));
  console.log(JSON.stringify({
    type: "message.updated",
    sessionID: sessionId,
    message: { role: "assistant", parts: [{ type: "text", text: responseText }] }
  }));
  process.exit(0);
}
console.error("unexpected opencode args", JSON.stringify(args));
process.exit(1);
`);
  fs.chmodSync(opencodePath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath);
  process.env.RAINDROP_WORKSHOP_OPENCODE_BIN = opencodePath;
  const mod = await import("../src/server");
  const db = await import("../src/db");
  const created = await mod.createServer(0);
  app = created.app;
  server = created.server;
  (globalThis as any).__closeDb = db.closeDb;
});

afterAll(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  else delete process.env.PATH;
  if (originalDbPath !== undefined) process.env.RAINDROP_WORKSHOP_DB_PATH = originalDbPath;
  else delete process.env.RAINDROP_WORKSHOP_DB_PATH;
  if (originalOpencodeBin !== undefined) process.env.RAINDROP_WORKSHOP_OPENCODE_BIN = originalOpencodeBin;
  else delete process.env.RAINDROP_WORKSHOP_OPENCODE_BIN;
  if (originalOpencodeCliChat !== undefined) process.env.RAINDROP_WORKSHOP_OPENCODE_CLI_CHAT = originalOpencodeCliChat;
  else delete process.env.RAINDROP_WORKSHOP_OPENCODE_CLI_CHAT;
  if (originalStateDir !== undefined) process.env.RAINDROP_WORKSHOP_STATE_DIR = originalStateDir;
  else delete process.env.RAINDROP_WORKSHOP_STATE_DIR;
  server?.close?.();
  (globalThis as any).__closeDb?.();
  if (tempStateDir) fs.rmSync(tempStateDir, { recursive: true, force: true });
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
  expect(res.body.opencode).toEqual(expect.objectContaining({ mode: "opencode_exec_stream", state: "green" }));
});

test("sessions route supports the opencode provider", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app).get("/api/agent/sessions");
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test("messages route can execute a mocked OpenCode CLI turn successfully", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app)
    .post("/api/agent/messages")
    .send({ content: "hello from test", session_id: null, run_id: null, client_message_id: "msg-test" });

  expect(res.status).toBe(200);
  expect(res.body.text).toBe("mock response");
});

test("session detail route returns OpenCode-exported messages", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app).get("/api/agent/sessions/ses_mock");

  expect(res.status).toBe(200);
  expect(res.body.id).toBe("ses_mock");
  expect(res.body.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
});

test("messages route returns an OpenCode session detail, not a Codex session", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app)
    .post("/api/agent/messages")
    .send({ content: "hello from test", session_id: null, run_id: null, client_message_id: "msg-test" });

  expect(res.status).toBe(200);
  expect(res.body.session_id).toBe("ses_mock");
  expect(res.body.text).toBe("mock response");
  expect(res.body.session).toEqual(expect.objectContaining({
    id: "ses_mock",
    preview: "hello from test",
  }));
  expect(res.body.events.map((event: { type: string }) => event.type)).toEqual(["provider_session", "loadout", "status", "done"]);
});

test("messages route resumes an existing OpenCode session", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app)
    .post("/api/agent/messages")
    .send({ content: "resume from test", session_id: "ses_resume", run_id: null, client_message_id: "msg-resume-test" });

  expect(res.status).toBe(200);
  expect(res.body.session_id).toBe("ses_resume");
  expect(res.body.text).toBe("resumed response");
  expect(res.body.session).toEqual(expect.objectContaining({
    id: "ses_resume",
    preview: "resume from test",
  }));
  expect(res.body.events.map((event: { type: string }) => event.type)).toEqual(["status", "done"]);
});

test("messages route returns OpenCode stderr failures as 502 responses", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app)
    .post("/api/agent/messages")
    .send({ content: "fail from test", session_id: null, run_id: null, client_message_id: "msg-fail-test" });

  expect(res.status).toBe(502);
  expect(res.body.error).toContain("permission denied from opencode");
  expect(res.body.session_id).toBeNull();
  expect(res.body.events.map((event: { type: string }) => event.type)).toEqual(["done"]);
});

test("messages route returns OpenCode error events as 502 responses with stream events", async () => {
  await request(app).post("/api/agent/provider").send({ provider: "opencode" });
  const res = await request(app)
    .post("/api/agent/messages")
    .send({ content: "error event from test", session_id: null, run_id: null, client_message_id: "msg-error-test" });

  expect(res.status).toBe(502);
  expect(res.body.error).toBe("model unavailable from opencode");
  expect(res.body.session_id).toBe("ses_error");
  expect(res.body.events.map((event: { type: string }) => event.type)).toEqual(["provider_session", "loadout", "error", "done"]);
});

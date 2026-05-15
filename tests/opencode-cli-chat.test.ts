import { expect, test } from "bun:test";
import fs from "node:fs";
import { buildOpencodeArgs, handleOpencodeEvent } from "../src/opencode-cli-chat";
import type { AgentStreamEvent } from "../src/agent-chat";

function runEvent(raw: unknown) {
  const emitted: AgentStreamEvent[] = [];
  const providerSessions: string[] = [];
  const texts: string[] = [];
  const errors: string[] = [];

  const result = handleOpencodeEvent(raw, {
    content: "",
    providerSessionId: null,
    seenEvents: new Set<string>(),
    onProviderSession(sessionId) {
      providerSessions.push(sessionId);
    },
    onText(content) {
      texts.push(content);
    },
    onStatus() {},
    onError(content) {
      errors.push(content);
    },
    emit(event) {
      emitted.push(event);
    },
  });

  return { emitted, providerSessions, texts, errors, result };
}

test("OpenCode error events map into provider_session + error stream events", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("./fixtures/opencode-stream-error.jsonl", import.meta.url), "utf8").trim());
  const outcome = runEvent(raw);

  expect(outcome.providerSessions).toEqual(["ses_1d7816c6effegz7vOFe5SpVL6r"]);
  expect(outcome.errors[0]).toContain("Model not found");
  expect(outcome.emitted.map((event) => event.type)).toEqual(["provider_session", "loadout", "error", "done"]);
});

test("synthetic OpenCode text and tool events are normalized", () => {
  const outcome = runEvent({
    type: "message.part.updated",
    sessionID: "ses_demo",
    part: {
      type: "tool_call",
      id: "tool_1",
      name: "read_file",
      input: { path: "README.md" },
    },
  });
  const textOutcome = runEvent({
    type: "message.updated",
    sessionID: "ses_demo",
    message: {
      role: "assistant",
      parts: [{ type: "text", text: "hello from opencode" }],
    },
  });

  expect(outcome.emitted.find((event) => event.type === "tool_start")).toMatchObject({
    type: "tool_start",
    name: "read_file",
  });
  expect(textOutcome.texts).toEqual(["hello from opencode"]);
});

test("OpenCode args include model, permissions, cwd, and resume session when configured", () => {
  const previousModel = process.env.RAINDROP_WORKSHOP_OPENCODE_MODEL;
  const previousSkip = process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS;
  process.env.RAINDROP_WORKSHOP_OPENCODE_MODEL = "opencode/big-pickle";
  process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS = "1";
  try {
    const args = buildOpencodeArgs({
      backendUrl: "http://localhost:5899",
      content: "hello",
      cwd: "/tmp/project",
      runId: "run_demo",
      resumeSessionId: "ses_demo",
    });
    expect(args.slice(0, -1)).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/tmp/project",
      "--dangerously-skip-permissions",
      "--model",
      "opencode/big-pickle",
      "--session",
      "ses_demo",
      "--",
    ]);
    expect(args.at(-1)).toContain("You are replying inside the Raindrop Workshop chat pane.");
    expect(args.at(-1)).toContain("The Raindrop MCP server is configured as `raindrop`");
    expect(args.at(-1)).toContain("session_id: ses_demo");
    expect(args.at(-1)).toContain("run_id: run_demo");
    expect(args.at(-1)).toMatch(/\nhello$/);
  } finally {
    if (previousModel === undefined) delete process.env.RAINDROP_WORKSHOP_OPENCODE_MODEL;
    else process.env.RAINDROP_WORKSHOP_OPENCODE_MODEL = previousModel;
    if (previousSkip === undefined) delete process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS;
    else process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS = previousSkip;
  }
});

test("OpenCode args include a raw user title for new sessions", () => {
  const previousSkip = process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS;
  process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS = "0";
  try {
    const args = buildOpencodeArgs({
      backendUrl: "http://localhost:5899",
      content: "Explain this trace",
      cwd: "/tmp/project",
      runId: "run_demo",
      resumeSessionId: null,
    });
    expect(args.slice(0, -1)).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/tmp/project",
      "--title",
      "Explain this trace",
      "--",
    ]);
    expect(args.at(-1)).toMatch(/\nExplain this trace$/);
  } finally {
    if (previousSkip === undefined) delete process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS;
    else process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS = previousSkip;
  }
});

test("OpenCode status, thinking, and tool-finish events are normalized", () => {
  const seenEvents = new Set<string>();
  const emitted: AgentStreamEvent[] = [];
  const statuses: string[] = [];
  const state = {
    content: "",
    providerSessionId: "ses_demo",
    seenEvents,
    onProviderSession() {},
    onText() {},
    onStatus(status: string) {
      statuses.push(status);
    },
    onError() {},
    emit(event: AgentStreamEvent) {
      emitted.push(event);
    },
  };

  handleOpencodeEvent({
    type: "session.status",
    sessionID: "ses_demo",
    status: "planning",
  }, state);
  handleOpencodeEvent({
    type: "message.part.updated",
    sessionID: "ses_demo",
    part: {
      type: "reasoning",
      text: "Thinking through the next step",
    },
  }, state);
  handleOpencodeEvent({
    type: "message.part.updated",
    sessionID: "ses_demo",
    part: {
      type: "tool_result",
      id: "tool_1",
      name: "read_file",
      result: { output: "done" },
    },
  }, state);

  expect(statuses).toEqual(["planning"]);
  expect(emitted).toEqual([
    { type: "status", content: "planning" },
    { type: "thinking_delta", content: "Thinking through the next step" },
    { type: "tool_finish", id: "tool_1", ok: true, output_preview: "{\"output\":\"done\"}" },
  ]);
});

test("OpenCode step-finish events emit usage", () => {
  const emitted: AgentStreamEvent[] = [];

  handleOpencodeEvent({
    type: "step_finish",
    sessionID: "ses_demo",
    part: {
      type: "step-finish",
      tokens: { input: 10, output: 4 },
      cost: 0.02,
    },
  }, {
    content: "",
    providerSessionId: "ses_demo",
    seenEvents: new Set<string>(),
    onProviderSession() {},
    onText() {},
    onStatus() {},
    onError() {},
    emit(event) {
      emitted.push(event);
    },
  });

  expect(emitted).toEqual([{ type: "usage", input_tokens: 10, output_tokens: 4, cost_usd: 0.02 }]);
});

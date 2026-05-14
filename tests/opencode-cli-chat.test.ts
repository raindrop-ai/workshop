import { expect, test } from "bun:test";
import fs from "node:fs";
import { handleOpencodeEvent } from "../src/opencode-cli-chat";
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

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { defaultAgentLoadout, type AgentCliChatHandlers, type AgentCliChatInput, type AgentCliChatResult, type AgentStreamEvent } from "./agent-chat";
import { getOpencodeSession } from "./opencode-sessions";

export type OpencodeCliChatInput = AgentCliChatInput;
export type OpencodeCliChatHandlers = AgentCliChatHandlers;
export type OpencodeCliChatResult = AgentCliChatResult;

export async function runOpencodeCliChat(
  input: OpencodeCliChatInput,
  handlers: OpencodeCliChatHandlers,
): Promise<OpencodeCliChatResult> {
  const args = buildOpencodeArgs(input);
  const child = spawn(process.env.RAINDROP_WORKSHOP_OPENCODE_BIN ?? "opencode", args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      RAINDROP_WORKSHOP_URL: input.backendUrl,
      RAINDROP_WORKSHOP_AGENT_PROVIDER: "opencode",
      RAINDROP_WORKSHOP_ANNOTATION_SOURCE: "opencode",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (input.abortSignal) {
    if (input.abortSignal.aborted) child.kill("SIGINT");
    input.abortSignal.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
  }
  return consumeOpencodeStream(child, input, handlers);
}

export function buildOpencodeArgs(input: OpencodeCliChatInput): string[] {
  const args = ["run", "--format", "json", "--dir", input.cwd];
  if (process.env.RAINDROP_WORKSHOP_OPENCODE_SKIP_PERMISSIONS !== "0") {
    args.push("--dangerously-skip-permissions");
  }
  const model = process.env.RAINDROP_WORKSHOP_OPENCODE_MODEL;
  if (model) args.push("--model", model);
  if (input.resumeSessionId) {
    args.push("--session", input.resumeSessionId);
  }
  args.push(input.content);
  return args;
}

function consumeOpencodeStream(
  child: ChildProcessByStdio<null, Readable, Readable>,
  input: OpencodeCliChatInput,
  handlers: OpencodeCliChatHandlers,
): Promise<OpencodeCliChatResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let content = "";
    let providerSessionId: string | null = input.resumeSessionId ?? null;
    const seenEvents = new Set<string>();

    const applyEvent = (event: unknown) => {
      const next = handleOpencodeEvent(event, {
        content,
        providerSessionId,
        seenEvents,
        onProviderSession(sessionId) {
          providerSessionId = sessionId;
          handlers.onProviderSession(sessionId);
        },
        onText(nextContent) {
          content = nextContent;
          handlers.onText(nextContent);
        },
        onStatus(status) {
          handlers.onStatus(status);
        },
        onError(nextError) {
          handlers.onError?.(nextError);
        },
        emit(event) {
          handlers.onEvent?.(event);
        },
      });
      content = next.content;
      providerSessionId = next.providerSessionId;
    };

    child.on("error", reject);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseJsonLine(line);
        if (!event) continue;
        applyEvent(event);
      }
    });
    child.on("close", (code, signal) => {
      if (stdout.trim()) {
        const event = parseJsonLine(stdout);
        if (event) applyEvent(event);
      }
      if ((!content || code === 0) && providerSessionId) {
        const session = getOpencodeSession(input.cwd, providerSessionId);
        const assistant = session?.messages.filter((message) => message.role === "assistant").at(-1);
        if (assistant?.content && assistant.content !== content) {
          content = assistant.content;
          handlers.onText(content);
        }
      }
      resolve({ code, signal, stderr });
    });
  });
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function handleOpencodeEvent(
  raw: unknown,
  state: {
    content: string;
    providerSessionId: string | null;
    seenEvents: Set<string>;
    onProviderSession(sessionId: string): void;
    onText(content: string): void;
    onStatus(status: string): void;
    onError(content: string): void;
    emit(event: AgentStreamEvent): void;
  },
): { content: string; providerSessionId: string | null } {
  if (!raw || typeof raw !== "object") return state;
  const event = raw as Record<string, unknown>;
  const sessionId = opencodeSessionId(event);
  let providerSessionId = state.providerSessionId;
  if (sessionId && sessionId !== state.providerSessionId) {
    providerSessionId = sessionId;
    state.onProviderSession(sessionId);
    state.emit({ type: "provider_session", sessionId });
    state.emit({ type: "loadout", ...defaultAgentLoadout("opencode") });
  }

  if (event.type === "error") {
    const message =
      stringValue(objectValue(event.error)?.message) ??
      stringValue(objectValue(objectValue(event.error)?.data)?.message) ??
      "OpenCode returned an error.";
    state.onError(message);
    state.emit({ type: "error", content: message });
    state.emit({ type: "done" });
    return { content: state.content, providerSessionId };
  }

  const text = textFromEvent(event);
  if (text && text !== state.content) {
    state.onText(text);
    return { content: text, providerSessionId };
  }

  const tool = toolEventFromEvent(event);
  if (tool) {
    const key = `${tool.type}:${tool.id}`;
    if (!state.seenEvents.has(key)) {
      state.seenEvents.add(key);
      state.emit(tool);
    }
    return { content: state.content, providerSessionId };
  }

  const thinking = thinkingFromEvent(event);
  if (thinking) {
    state.emit({ type: "thinking_delta", content: thinking });
    return { content: state.content, providerSessionId };
  }

  const status = statusFromEvent(event);
  if (status) {
    state.onStatus(status);
    state.emit({ type: "status", content: status });
  }

  return { content: state.content, providerSessionId };
}

function opencodeSessionId(event: Record<string, unknown>): string | null {
  return stringValue(event.sessionID)
    ?? stringValue(event.sessionId)
    ?? stringValue(objectValue(event.session)?.id)
    ?? null;
}

function textFromEvent(event: Record<string, unknown>): string | null {
  const message = objectValue(event.message);
  if (message?.role === "assistant") {
    const text = extractText(message.parts ?? message.content);
    if (text) return text;
  }
  const part = objectValue(event.part);
  if (part?.type === "text") {
    return stringValue(part.text);
  }
  return null;
}

function thinkingFromEvent(event: Record<string, unknown>): string | null {
  const part = objectValue(event.part);
  if (part?.type === "reasoning" || part?.type === "thinking") {
    return stringValue(part.text) ?? stringValue(part.reasoning) ?? stringValue(part.content);
  }
  return null;
}

function toolEventFromEvent(event: Record<string, unknown>): Extract<AgentStreamEvent, { type: "tool_start" | "tool_finish" }> | null {
  const part = objectValue(event.part);
  const partType = stringValue(part?.type) ?? "";
  const toolName =
    stringValue(part?.name) ??
    stringValue(objectValue(part?.toolCall)?.name) ??
    stringValue(objectValue(part?.call)?.name);
  if (!toolName && !partType.includes("tool")) return null;
  const id = stringValue(part?.id) ?? `${toolName ?? "tool"}-${Date.now()}`;
  const done = partType.includes("result") || partType.includes("output");
  if (done) {
    return {
      type: "tool_finish",
      id,
      ok: part?.error !== true,
      output_preview: previewString(JSON.stringify(part?.output ?? part?.result ?? {})),
    };
  }
  return {
    type: "tool_start",
    id,
    name: toolName ?? "tool",
    input_preview: previewString(JSON.stringify(part?.input ?? objectValue(part?.call)?.input ?? {})),
  };
}

function statusFromEvent(event: Record<string, unknown>): string | null {
  const type = stringValue(event.type) ?? "";
  if (type.includes("status")) {
    return stringValue(event.status) ?? stringValue(objectValue(event.data)?.status) ?? "OpenCode is working...";
  }
  return null;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((part) => {
      if (typeof part === "string") return part;
      const typed = objectValue(part);
      return stringValue(typed?.text) ?? "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function previewString(value: string): string | undefined {
  if (!value || value === "{}") return undefined;
  return value.length > 160 ? `${value.slice(0, 160)}...` : value;
}

export const _internal = {
  opencodeSessionId,
  textFromEvent,
  thinkingFromEvent,
  toolEventFromEvent,
};

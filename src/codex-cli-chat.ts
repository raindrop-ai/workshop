import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import {
  agentAnnotationSource,
  defaultAgentLoadout,
  raindropMcpToolList,
  resolveWorkshopMcpCommand,
  type AgentCliChatHandlers,
  type AgentCliChatInput,
  type AgentCliChatResult,
  type AgentLoadout,
  type AgentStreamEvent,
} from "./agent-chat";

export type CodexCliChatInput = AgentCliChatInput;
export type CodexCliChatHandlers = AgentCliChatHandlers;
export type CodexCliChatResult = AgentCliChatResult;

export function runCodexCliChat(
  input: CodexCliChatInput,
  handlers: CodexCliChatHandlers,
): Promise<CodexCliChatResult> {
  const args = buildCodexArgs(input);
  const child = spawn(process.env.RAINDROP_WORKSHOP_CODEX_BIN ?? "codex", args, {
    cwd: input.cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (input.abortSignal) {
    if (input.abortSignal.aborted) child.kill("SIGINT");
    input.abortSignal.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
  }
  return consumeCodexStream(child, handlers);
}

export function buildCodexArgs(input: CodexCliChatInput): string[] {
  const mcpCommand = resolveWorkshopMcpCommand();
  const commonArgs = [
    "-C",
    input.cwd,
    "-c",
    `mcp_servers.workshop.command=${JSON.stringify(mcpCommand.command)}`,
    "-c",
    `mcp_servers.workshop.args=${JSON.stringify(mcpCommand.args)}`,
    "-c",
    `mcp_servers.workshop.env={RAINDROP_WORKSHOP_URL=${JSON.stringify(input.backendUrl)},RAINDROP_WORKSHOP_AGENT_PROVIDER="codex",RAINDROP_WORKSHOP_ANNOTATION_SOURCE=${JSON.stringify(agentAnnotationSource("codex"))}}`,
  ];
  if (process.env.RAINDROP_WORKSHOP_CODEX_BYPASS_PERMISSIONS !== "0") {
    commonArgs.unshift("--dangerously-bypass-approvals-and-sandbox");
  } else {
    commonArgs.unshift("-a", process.env.RAINDROP_WORKSHOP_CODEX_APPROVAL_POLICY ?? "never");
    const sandbox = process.env.RAINDROP_WORKSHOP_CODEX_SANDBOX;
    if (sandbox) commonArgs.push("--sandbox", sandbox);
  }

  const commandArgs = input.resumeSessionId
    ? ["exec", "resume", "--json", input.resumeSessionId]
    : ["exec", "--json"];

  return [
    ...commonArgs,
    ...commandArgs,
    userPrompt(input),
  ];
}

function directReplySystemPrompt(input: CodexCliChatInput): string {
  const runInstruction = input.runId
    ? `The current Workshop trace is ${input.runId}. Use the Raindrop trace tools as needed when the user asks about "this trace" or the trace context matters; get_run_outline is usually the fastest first read, and get_span_payload is for exact raw payload evidence.`
    : "No Workshop trace is currently selected.";

  return [
    "You are replying inside the Raindrop Workshop chat pane.",
    "Your stdout is streamed directly into the Workshop UI.",
    "Use normal assistant text as your final answer. Markdown is supported.",
    "Use the Workshop MCP tools to inspect traces, read span payloads, annotate findings, and show evidence in the UI.",
    "The Workshop MCP server is configured as `workshop` with these tools:",
    raindropMcpToolList(),
    "If the user asks what Workshop tools are available, answer from that list instead of saying no tools are visible.",
    runInstruction,
  ].join(" ");
}

function userPrompt(input: CodexCliChatInput): string {
  const lines = [
    directReplySystemPrompt(input),
    "",
    "<workshop_message>",
  ];
  if (input.sessionId) lines.push(`session_id: ${input.sessionId}`);
  if (input.userMessageId) lines.push(`message_id: ${input.userMessageId}`);
  if (input.runId) lines.push(`run_id: ${input.runId}`);
  lines.push("</workshop_message>", "", input.content);
  return lines.join("\n");
}

function consumeCodexStream(
  child: ChildProcessByStdio<null, Readable, Readable>,
  handlers: CodexCliChatHandlers,
): Promise<CodexCliChatResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let content = "";

    const applyEvent = (event: unknown) => {
      const next = handleCodexEvent(event, {
        content,
        onProviderSession: (sessionId) => handlers.onProviderSession(sessionId),
        onStatus: (status) => handlers.onStatus(status),
        onText: (nextContent) => handlers.onText(nextContent),
        onError: (content) => handlers.onError?.(content),
        emit: (e) => handlers.onEvent?.(e),
      });
      content = next.content;
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

export function handleCodexEvent(
  raw: unknown,
  state: {
    content: string;
    onProviderSession(sessionId: string): void;
    onStatus(status: string): void;
    onText(content: string): void;
    onError(content: string): void;
    emit(event: AgentStreamEvent): void;
  },
): { content: string } {
  if (!raw || typeof raw !== "object") return state;
  const event = raw as Record<string, unknown>;

  if (event.type === "event_msg") {
    const payload = objectValue(event.payload);
    if (payload?.type === "agent_message") {
      const message = stringValue(payload.message);
      if (message && message !== state.content) {
        state.onText(message);
        return { content: message };
      }
    }
    if (payload?.type === "task_complete") state.emit({ type: "done" });
    return state;
  }

  if (event.type === "response_item") {
    const item = objectValue(event.payload);
    return handleCodexResponseItem(item, state);
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    state.onProviderSession(event.thread_id);
    state.emit({ type: "provider_session", sessionId: event.thread_id });
    state.emit({ type: "loadout", ...codexLoadout() });
    return state;
  }

  if (event.type === "item.started") {
    const item = objectValue(event.item);
    if (item?.type === "command_execution" && typeof item.command === "string") {
      state.emit({ type: "tool_start", id: stringValue(item.id) ?? item.command, name: "exec_command", input_preview: item.command });
      state.onStatus("Using exec_command...");
    }
    if (item?.type === "mcp_tool_call") {
      const name = mcpToolName(item);
      state.emit({ type: "tool_start", id: stringValue(item.id) ?? name, name, input_preview: previewString(JSON.stringify(item.arguments ?? {})) });
      state.onStatus(`Using ${name}...`);
    }
    return state;
  }

  if (event.type === "item.completed") {
    const item = objectValue(event.item);
    if (item?.type === "agent_message" && typeof item.text === "string") {
      state.onText(item.text);
      return { content: item.text };
    }
    if (item?.type === "command_execution") {
      state.emit({
        type: "tool_finish",
        id: stringValue(item.id) ?? stringValue(item.command) ?? "command_execution",
        ok: item.exit_code === 0 || item.status === "completed",
        output_preview: previewString(stringValue(item.aggregated_output) ?? ""),
      });
      return state;
    }
    if (item?.type === "mcp_tool_call") {
      const error = objectValue(item.error);
      state.emit({
        type: "tool_finish",
        id: stringValue(item.id) ?? mcpToolName(item),
        ok: !error,
        output_preview: previewString(JSON.stringify(error ?? item.result ?? {})),
      });
      return state;
    }
    if (item?.type && typeof item.type === "string") {
      state.emit({
        type: "tool_finish",
        id: stringValue(item.id) ?? item.type,
        ok: true,
        output_preview: previewString(JSON.stringify(item)),
      });
    }
    return state;
  }

  if (event.type === "turn.completed") {
    const usage = objectValue(event.usage);
    state.emit({
      type: "usage",
      input_tokens: numberValue(usage?.input_tokens),
      output_tokens: numberValue(usage?.output_tokens),
    });
    state.emit({ type: "done" });
  }

  if (event.type === "error") {
    const message = stringValue(event.message) ?? "Codex returned an error.";
    state.onError(message);
    state.emit({ type: "done" });
  }

  return state;
}

function handleCodexResponseItem(
  item: Record<string, unknown> | null,
  state: {
    content: string;
    onText(content: string): void;
    emit(event: AgentStreamEvent): void;
  },
): { content: string } {
  if (!item) return state;
  if (item.type === "message" && item.role === "assistant") {
    const text = contentText(item.content);
    if (text && text !== state.content) {
      state.onText(text);
      return { content: text };
    }
    return state;
  }
  if (item.type === "function_call") {
    const id = stringValue(item.call_id) ?? `${codexToolName(item)}-${Date.now()}`;
    state.emit({
      type: "tool_start",
      id,
      name: codexToolName(item),
      input_preview: previewString(stringValue(item.arguments) ?? ""),
    });
    return state;
  }
  if (item.type === "function_call_output") {
    const id = stringValue(item.call_id) ?? "function_call";
    state.emit({
      type: "tool_finish",
      id,
      ok: true,
      output_preview: previewString(stringValue(item.output) ?? ""),
    });
  }
  return state;
}

function mcpToolName(item: Record<string, unknown>): string {
  const server = stringValue(item.server) ?? "mcp";
  const tool = stringValue(item.tool) ?? "tool";
  return `${server}.${tool}`;
}

function codexToolName(item: Record<string, unknown>): string {
  const name = stringValue(item.name) ?? "tool";
  const namespace = stringValue(item.namespace);
  if (namespace === "mcp__workshop__" || namespace === "mcp__raindrop__") return `workshop.${name}`;
  return namespace ? `${namespace}.${name}` : name;
}

function codexLoadout(): AgentLoadout {
  return defaultAgentLoadout("codex");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const typed = objectValue(part);
      return typeof typed?.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function previewString(value: string): string | undefined {
  if (!value) return undefined;
  return value.length > 160 ? `${value.slice(0, 160)}...` : value;
}

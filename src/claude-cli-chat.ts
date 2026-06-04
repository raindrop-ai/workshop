import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import {
  agentAnnotationSource,
  chatChildEnv,
  hasCloudMcpConfigured,
  localCloudMcpProxyUrl,
  QUERY_API_KEY_TOKEN_ENV,
  resolveWorkshopMcpCommand,
  workshopSidepanelPrompt,
  type AgentLoadout,
  type AgentStreamEvent,
} from "./agent-chat";

export interface ClaudeCliChatInput {
  backendUrl: string;
  content: string;
  cwd: string;
  runId?: string | null;
  sessionId?: string | null;
  userMessageId?: string | null;
  resumeSessionId?: string | null;
  queryApiKey?: string | null;
  queryApiKeyToken?: string | null;
  abortSignal?: AbortSignal;
}

export interface ClaudeCliChatHandlers {
  onEvent?(event: AgentStreamEvent): void;
  onClaudeSession(sessionId: string): void;
  onText(content: string): void;
  onStatus(status: string): void;
  onError?(content: string): void;
}

export interface ClaudeCliChatResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export function runClaudeCliChat(
  input: ClaudeCliChatInput,
  handlers: ClaudeCliChatHandlers,
): Promise<ClaudeCliChatResult> {
  const child = spawn(process.env.RAINDROP_WORKSHOP_CLAUDE_BIN ?? "claude", buildClaudeArgs(input), {
    cwd: input.cwd,
    env: chatChildEnv(input.queryApiKeyToken),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (input.abortSignal) {
    if (input.abortSignal.aborted) child.kill("SIGINT");
    input.abortSignal.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
  }
  return consumeClaudeStream(child, handlers);
}

export function buildClaudeArgs(input: ClaudeCliChatInput): string[] {
  const mcpCommand = resolveWorkshopMcpCommand();
  const mcpConfig = buildMcpConfig(input.backendUrl, mcpCommand, input.queryApiKey, input.queryApiKeyToken);
  const allowedMcpTools = Object.keys(mcpConfig.mcpServers)
    .map((name) => `mcp__${name}__*`)
    .join(",");

  // Deliberately do not pass --bare, --strict-mcp-config, or --tools.
  // Workshop wants the user's normal Claude Code environment:
  // project CLAUDE.md, skills, plugins, hooks, memories, and existing MCPs.
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--permission-mode",
    process.env.RAINDROP_WORKSHOP_CLAUDE_PERMISSION_MODE ?? "bypassPermissions",
    "--allowedTools",
    allowedMcpTools,
    "--settings",
    JSON.stringify(askUserQuestionHookSettings(input.backendUrl)),
    "--append-system-prompt",
    directReplySystemPrompt(input),
  ];

  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  } else {
    args.push("--name", `Raindrop Workshop ${Date.now().toString(36)}`);
  }

  args.push(userPrompt(input));
  return args;
}

export function buildMcpConfig(
  backendUrl: string,
  mcpCommand = resolveWorkshopMcpCommand(),
  queryApiKey?: string | null,
  queryApiKeyToken?: string | null,
): {
  mcpServers: Record<string, Record<string, unknown>>;
} {
  const workshopEnv: Record<string, string> = {
    RAINDROP_WORKSHOP_URL: backendUrl,
    RAINDROP_WORKSHOP_AGENT_PROVIDER: "claude",
    RAINDROP_WORKSHOP_ANNOTATION_SOURCE: agentAnnotationSource("claude"),
  };
  if (queryApiKeyToken?.trim()) {
    workshopEnv.RAINDROP_WORKSHOP_QUERY_API_KEY_TOKEN = queryApiKeyToken.trim();
  }
  const mcpServers: Record<string, Record<string, unknown>> = {
    raindrop_workshop: {
      command: mcpCommand.command,
      args: mcpCommand.args,
      env: workshopEnv,
    },
  };

  if (hasCloudMcpConfigured(queryApiKey, queryApiKeyToken)) {
    // Point at the daemon's local proxy and authenticate with the transient
    // per-spawn token. The agent process never has the real Raindrop Query
    // API key in its environment; the daemon resolves the token to the key
    // server-side before forwarding upstream.
    mcpServers.raindrop_cloud = {
      type: "http",
      url: localCloudMcpProxyUrl(backendUrl),
      headers: {
        Authorization: `Bearer \${${QUERY_API_KEY_TOKEN_ENV}}`,
      },
    };
  }

  return { mcpServers };
}

function askUserQuestionHookSettings(backendUrl: string): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [
            {
              type: "command",
              command: askUserQuestionHookCommand(`${backendUrl}/api/claude/ask-user-question/hook`),
              // Command hooks have a default timeout; this one may wait on a human.
              timeout: 1800,
            },
          ],
        },
      ],
    },
  };
}

function askUserQuestionHookCommand(url: string): string {
  const script = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const res = await fetch(${JSON.stringify(url)}, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || \`HTTP \${res.status}\`);
    process.stdout.write(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    }));
  }
});
`;
  return `${process.env.RAINDROP_WORKSHOP_HOOK_NODE_BIN ?? "node"} -e ${shellArg(script)}`;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function directReplySystemPrompt(input: ClaudeCliChatInput): string {
  return workshopSidepanelPrompt({
    provider: "claude",
    localMcpName: "raindrop_workshop",
    runId: input.runId,
    queryApiKey: input.queryApiKey,
    queryApiKeyToken: input.queryApiKeyToken,
  });
}

function userPrompt(input: ClaudeCliChatInput): string {
  const lines = [
    "<workshop_message>",
  ];
  if (input.sessionId) lines.push(`session_id: ${input.sessionId}`);
  if (input.userMessageId) lines.push(`message_id: ${input.userMessageId}`);
  if (input.runId) lines.push(`run_id: ${input.runId}`);
  lines.push("</workshop_message>", "", input.content);
  return lines.join("\n");
}

function consumeClaudeStream(
  child: ChildProcessByStdio<null, Readable, Readable>,
  handlers: ClaudeCliChatHandlers,
): Promise<ClaudeCliChatResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let content = "";
    let activeTool: string | null = null;
    const toolBlocks = new Map<number, { id: string; name: string; input: string }>();
    const applyEvent = (event: unknown) => {
      const next = handleClaudeEvent(event, {
        content,
        activeTool,
        toolBlocks,
        emit: (e) => handlers.onEvent?.(e),
        onClaudeSession: (sessionId) => handlers.onClaudeSession(sessionId),
        onStatus: (status) => handlers.onStatus(status),
        onText: (nextContent) => handlers.onText(nextContent),
        onError: (content) => handlers.onError?.(content),
      });
      content = next.content;
      activeTool = next.activeTool;
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

function handleClaudeEvent(
  raw: unknown,
  state: {
    content: string;
    activeTool: string | null;
    onClaudeSession(sessionId: string): void;
    onStatus(status: string): void;
    onText(content: string): void;
    onError(content: string): void;
    emit(event: AgentStreamEvent): void;
    toolBlocks: Map<number, { id: string; name: string; input: string }>;
  },
): { content: string; activeTool: string | null } {
  if (!raw || typeof raw !== "object") return state;
  const event = raw as Record<string, unknown>;

  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    state.onClaudeSession(event.session_id);
    state.emit({ type: "loadout", ...extractLoadout(event) });
    return state;
  }

  if (event.type === "stream_event") {
    return handleStreamEvent(event.event, state);
  }

  if (event.type === "assistant") {
    const finalText = extractAssistantText(event.message);
    if (finalText && finalText !== state.content) {
      state.onText(finalText);
      return { content: finalText, activeTool: state.activeTool };
    }
  }

  if (event.type === "result" && event.is_error === true) {
    const text = Array.isArray(event.errors)
      ? event.errors.map(String).join("\n")
      : typeof event.result === "string"
        ? event.result
        : "Claude Code returned an error.";
    state.onError(text);
    state.emit({ type: "error", content: text });
    state.emit({ type: "done" });
    return { content: text, activeTool: state.activeTool };
  }

  if (event.type === "result" && event.is_error === false && typeof event.result === "string") {
    if (event.result && event.result !== state.content) {
      state.onText(event.result);
      state = { ...state, content: event.result };
    }
  }

  if (event.type === "result") {
    const usage = event.usage && typeof event.usage === "object"
      ? event.usage as Record<string, unknown>
      : {};
    state.emit({
      type: "usage",
      input_tokens: numberValue(usage.input_tokens),
      output_tokens: numberValue(usage.output_tokens),
      cost_usd: numberValue(event.total_cost_usd),
    });
    state.emit({ type: "done" });
  }

  return state;
}

function handleStreamEvent(
  raw: unknown,
  state: {
    content: string;
    activeTool: string | null;
    onClaudeSession(sessionId: string): void;
    onStatus(status: string): void;
    onText(content: string): void;
    onError(content: string): void;
    emit(event: AgentStreamEvent): void;
    toolBlocks: Map<number, { id: string; name: string; input: string }>;
  },
): { content: string; activeTool: string | null } {
  if (!raw || typeof raw !== "object") return state;
  const event = raw as Record<string, unknown>;

  if (event.type === "content_block_start") {
    const block = event.content_block;
    if (block && typeof block === "object") {
      const typedBlock = block as Record<string, unknown>;
      const blockType = typedBlock.type;
      const name = typedBlock.name;
      if (typeof name === "string" && name) {
        const id = typeof typedBlock.id === "string" ? typedBlock.id : `tool-${String(event.index ?? Date.now())}`;
        const index = typeof event.index === "number" ? event.index : -1;
        if (index >= 0) state.toolBlocks.set(index, { id, name, input: "" });
        state.emit({ type: "tool_start", id, name, input_preview: previewJson(typedBlock.input) });
        if (name === "Agent") {
          const input = typedBlock.input && typeof typedBlock.input === "object"
            ? typedBlock.input as Record<string, unknown>
            : {};
          const subagent = typeof input.subagent_type === "string" ? input.subagent_type : "subagent";
          state.emit({ type: "subagent_start", parent_id: id, subagent });
        }
        state.onStatus(`Using ${name}...`);
        return { content: state.content, activeTool: name };
      }
      if (blockType === "thinking") {
        state.emit({ type: "thinking_delta", content: "" });
      }
    }
  }

  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (!delta || typeof delta !== "object") return state;
    const typed = delta as Record<string, unknown>;
    if (typed.type === "text_delta" && typeof typed.text === "string") {
      const content = state.content + typed.text;
      state.onText(content);
      return { content, activeTool: state.activeTool };
    }
    if (typed.type === "thinking_delta" && typeof typed.thinking === "string") {
      state.emit({ type: "thinking_delta", content: typed.thinking });
    }
    if (typed.type === "input_json_delta" && state.activeTool) {
      const index = typeof event.index === "number" ? event.index : -1;
      const tool = state.toolBlocks.get(index);
      if (tool && typeof typed.partial_json === "string") {
        tool.input += typed.partial_json;
        state.emit({
          type: "tool_start",
          id: tool.id,
          name: tool.name,
          input_preview: previewString(tool.input),
        });
      }
      state.onStatus(`Using ${state.activeTool}...`);
    }
  }

  if (event.type === "content_block_stop") {
    const index = typeof event.index === "number" ? event.index : -1;
    const tool = state.toolBlocks.get(index);
    if (tool) {
      state.emit({ type: "tool_finish", id: tool.id, ok: true });
      state.toolBlocks.delete(index);
    }
    return { content: state.content, activeTool: null };
  }

  return state;
}

function extractLoadout(event: Record<string, unknown>): AgentLoadout {
  const mcpServers = Array.isArray(event.mcp_servers)
    ? event.mcp_servers.map((m) => {
        if (typeof m === "string") return m;
        if (m && typeof m === "object") {
          const typed = m as Record<string, unknown>;
          return typeof typed.name === "string" ? typed.name : typeof typed.id === "string" ? typed.id : null;
        }
        return null;
      }).filter((m): m is string => !!m)
    : [];
  const plugins = Array.isArray(event.plugins)
    ? event.plugins.map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const name = (p as Record<string, unknown>).name;
          return typeof name === "string" ? name : null;
        }
        return null;
      }).filter((p): p is string => !!p)
    : [];
  return {
    tools: stringArray(event.tools),
    mcps: mcpServers,
    skills: stringArray(event.skills),
    plugins,
    slash_commands: stringArray(event.slash_commands),
    model: typeof event.model === "string" ? event.model : undefined,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function previewJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return previewString(typeof value === "string" ? value : JSON.stringify(value));
}

function previewString(value: string): string {
  return value.length > 160 ? `${value.slice(0, 160)}...` : value;
}

function extractAssistantText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const content = (raw as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

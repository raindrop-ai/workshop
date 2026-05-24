import fs from "fs";
import os from "os";
import path from "path";

export type AgentProviderId = "claude" | "codex";
export type AgentAnnotationSource = "claude-code" | "codex";

export interface AgentLoadout {
  tools: string[];
  mcps: string[];
  skills: string[];
  plugins: string[];
  slash_commands?: string[];
  model?: string;
}

export type AgentStreamEvent =
  | { type: "provider_session"; sessionId: string }
  | ({ type: "loadout" } & AgentLoadout)
  | { type: "text"; content: string }
  | { type: "status"; content: string }
  | { type: "error"; content: string }
  | { type: "tool_start"; id: string; name: string; input_preview?: string }
  | { type: "tool_finish"; id: string; ok: boolean; output_preview?: string }
  | { type: "thinking_delta"; content: string }
  | { type: "subagent_start"; parent_id: string; subagent: string }
  | { type: "permission_denied"; tool: string; reason: string }
  | { type: "usage"; input_tokens?: number; output_tokens?: number; cost_usd?: number }
  | { type: "done" };

export interface AgentCliChatInput {
  backendUrl: string;
  content: string;
  cwd: string;
  runId?: string | null;
  sessionId?: string | null;
  userMessageId?: string | null;
  resumeSessionId?: string | null;
  forceAutoCompact?: boolean;
  abortSignal?: AbortSignal;
}

export interface AgentCliChatHandlers {
  onEvent?(event: AgentStreamEvent): void;
  onProviderSession(sessionId: string): void;
  onText(content: string): void;
  onStatus(status: string): void;
  onError?(content: string): void;
}

export interface AgentCliChatResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export const RAINDROP_MCP_TOOLS = [
  {
    name: "get_current_run",
    description: "resolve the run currently focused in Workshop",
  },
  {
    name: "query_traces",
    description: "run read-only SQL over trace tables for discovery and aggregation",
  },
  {
    name: "get_span_payload",
    description: "read full input or output payload slices for a span",
  },
  {
    name: "annotate",
    description: "create durable run or span annotations",
  },
  {
    name: "get_run_outline",
    description: "summarize a run before reading detailed payloads",
  },
  {
    name: "ask_agent",
    description: "ask the captured agent context about a trace",
  },
  {
    name: "replay_run",
    description: "replay a run through the normal local agent replay flow",
  },
  {
    name: "search_run",
    description: "search a run's span payloads, attributes, and live events",
  },
  {
    name: "get_span_context",
    description: "read nearby span skeletons around a span of interest",
  },
  {
    name: "show_in_ui",
    description: "open runs, filters, or drafted notes in the Workshop UI",
  },
] as const;

const STATE_PATH = path.join(os.homedir(), ".raindrop", "agent-provider.json");

export function getAgentProvider(): AgentProviderId {
  const envProvider = parseAgentProvider(process.env.RAINDROP_WORKSHOP_AGENT_PROVIDER);
  if (envProvider) return envProvider;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { provider?: unknown };
    return parseAgentProvider(parsed.provider) ?? "claude";
  } catch {
    return "claude";
  }
}

export function setAgentProvider(provider: AgentProviderId): AgentProviderId {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ provider, updated_at: new Date().toISOString() }, null, 2) + "\n");
  return provider;
}

export function parseAgentProvider(value: unknown): AgentProviderId | null {
  return value === "claude" || value === "codex" ? value : null;
}

export function defaultAgentLoadout(provider: AgentProviderId): AgentLoadout {
  return {
    tools: RAINDROP_MCP_TOOLS.map((tool) => `raindrop.${tool.name}`),
    mcps: ["raindrop"],
    skills: [],
    plugins: [],
    slash_commands: provider === "claude" ? [] : ["/clear", "/trace"],
  };
}

export function agentProviderLabel(provider: AgentProviderId): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

export function agentAnnotationSource(provider: AgentProviderId): AgentAnnotationSource {
  return provider === "codex" ? "codex" : "claude-code";
}

export function raindropMcpToolList(): string {
  return RAINDROP_MCP_TOOLS
    .map((tool) => `- raindrop.${tool.name}: ${tool.description}`)
    .join("\n");
}

export function resolveWorkshopMcpCommand(): { command: string; args: string[] } {
  const isCompiled = path
    .basename(process.execPath)
    .toLowerCase()
    .startsWith("raindrop");

  if (isCompiled) {
    return { command: process.execPath, args: ["workshop", "mcp"] };
  }

  return {
    command: process.execPath,
    args: [path.join(path.dirname(__filename), "index.ts"), "workshop", "mcp"],
  };
}

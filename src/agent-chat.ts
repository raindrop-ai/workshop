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
  queryApiKey?: string | null;
  queryApiKeyToken?: string | null;
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
    description: "resolve the focused Workshop run and selected span",
  },
  {
    name: "query_traces",
    description: "run read-only SQL over local trace tables",
  },
  {
    name: "get_span_payload",
    description: "read raw input or output payload slices for a span",
  },
  {
    name: "annotate",
    description: "create durable run or span annotations",
  },
  {
    name: "get_run_outline",
    description: "summarize a run's structure before reading payloads",
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
    name: "import_cloud_trace",
    description: "import a known production event trace into local Workshop",
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
    tools: RAINDROP_MCP_TOOLS.map((tool) => `workshop.${tool.name}`),
    mcps: ["workshop"],
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

export function hasCloudMcpConfigured(queryApiKey?: string | null, queryApiKeyToken?: string | null): boolean {
  return !!(queryApiKey?.trim() || queryApiKeyToken?.trim() || process.env.RAINDROP_QUERY_API_KEY?.trim());
}

export function cloudMcpUrl(): string {
  return process.env.RAINDROP_CLOUD_MCP_URL ?? "https://mcp.raindrop.ai/mcp";
}

/**
 * The local URL the spawned Claude/Codex subprocess should use for the
 * "raindrop_cloud" MCP server. Requests sent here are authenticated with a
 * per-spawn transient bearer token (the daemon swaps it for the real
 * Raindrop Query API key before forwarding to {@link cloudMcpUrl}). The agent
 * subprocess therefore never has the raw key in its environment.
 */
export function localCloudMcpProxyUrl(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/, "")}/proxy/cloud-mcp`;
}

/**
 * Env var the spawned agent's MCP transport reads to authenticate to the
 * local cloud MCP proxy. The value is a short-lived UUID that the daemon
 * resolves back to the Raindrop Query API key.
 */
export const QUERY_API_KEY_TOKEN_ENV = "RAINDROP_WORKSHOP_QUERY_API_KEY_TOKEN";

export interface WorkshopSidepanelPromptInput {
  provider: AgentProviderId;
  localMcpName: string;
  runId?: string | null;
  queryApiKey?: string | null;
  queryApiKeyToken?: string | null;
}

export function workshopSidepanelPrompt(input: WorkshopSidepanelPromptInput): string {
  return [
    ...baseSidepanelInstructions(input.localMcpName),
    ...prioritizationInstructions(input.provider),
    ...cloudInstructions(input.localMcpName, hasCloudMcpConfigured(input.queryApiKey, input.queryApiKeyToken), input.provider),
    providerCapabilities(input.provider),
    runInstruction(input.runId),
  ].join(" ");
}

function baseSidepanelInstructions(localMcpName: string): string[] {
  return [
    "You are replying inside the Raindrop Workshop sidepanel.",
    "Raindrop Workshop is the local trace-debugger UI and daemon for inspecting agent runs, spans, payloads, annotations, and replays.",
    "You are the sidepanel coding assistant, not the captured agent whose trace is being inspected, unless a tool explicitly continues captured agent context.",
    "Your stdout is streamed directly into the Workshop chat UI.",
    "Use normal assistant text as your final answer. Markdown is supported.",
    `The local Workshop MCP server is configured as ${localMcpName}; its tool descriptions and schemas are authoritative, so prefer them over remembered parameter shapes.`,
    "For every MCP tool call, use the exact argument names and types from that tool's input schema; do not substitute aliases such as id when the schema requires issue_id, event_id, run_id, or span_id.",
    "Before searching traces or importing from production for broad requests, first make sure you understand the problem the user is trying to solve and which local agent/codebase is relevant; inspect the local project context when that will help choose the right events, users, signals, or trace queries.",
    "When you import, identify, or discuss a concrete trace or span, prefer showing it in the Workshop UI as well as explaining it, unless the user is clearly asking only for text.",
  ];
}

function prioritizationInstructions(provider: AgentProviderId): string[] {
  const localContext = provider === "claude"
    ? "For those questions, first use any relevant Claude Code memory, project context, and available MCPs."
    : "For those questions, first use the active workspace, conversation context, and available MCPs.";
  return [
    `Treat open-ended prioritization questions like "what should I work on today?", "what needs attention?", or "where should I focus?" as requests to gather context before answering.`,
    localContext,
    "When Raindrop Cloud is available, search or summarize recent production signals, issues, events, users, or traces that could reveal urgent work; use local codebase context to choose useful cloud queries.",
    "Do not answer that you lack visibility into priorities until you have checked the relevant available context, or clearly explain which required source is unavailable.",
  ];
}

function cloudInstructions(localMcpName: string, configured: boolean, provider: AgentProviderId): string[] {
  if (!configured) {
    return [
      `Only the local ${localMcpName} MCP server is available in this chat; raindrop_cloud is not enabled because no Query API key is configured in Workshop.`,
      `Use ${localMcpName} for local Workshop runs, imported traces, span payloads, annotations, replay, and showing evidence in the Workshop UI.`,
      "If, and only if, the user explicitly asks to search, pull, import, or debug a production/cloud/Raindrop trace or event, gently ask them to add a Query API key in Workshop Settings before trying that cloud task.",
      "Do not import production/cloud traces unless a current-turn raindrop_cloud lookup verified the event id.",
    ];
  }
  const lines = [
    `Two Raindrop MCP surfaces are available: raindrop_cloud for production Raindrop data, and ${localMcpName} for local Workshop debugging which contains traces stored locally.`,
    "Use raindrop_cloud for prod/cloud search, events, users, signals, issues, and hosted trace lookup.",
    `Use ${localMcpName} for local Workshop runs, imported traces, span payloads, annotations, replay, and showing evidence in the Workshop UI.`,
    `When the user is talking about their product, production behavior, customers, users, conversations, events, signals, issues, or a real agent run, infer that production trace context may be useful even if they do not explicitly say "import". Search or verify the relevant event with raindrop_cloud, import the best matching trace into Workshop with ${localMcpName}, and show it in the Workshop UI before or while analyzing it.`,
    `When the user chooses or asks to inspect a concrete cloud issue, event, signal, user, or trace from search results, treat that as permission to pull the associated trace: verify the event id with raindrop_cloud in the current turn, import it immediately with ${localMcpName}, and focus it in the Workshop UI before giving the analysis.`,
    "Do not stop after summarizing the issue and ask whether to import; only ask a clarifying question first when cloud metadata leaves multiple materially different traces and you cannot choose the best one.",
    "If there are several plausible production traces, use cloud metadata to narrow them; ask a concise clarifying question only when the choice would materially change the analysis.",
  ];
  if (provider === "claude") {
    lines.push("When you learn reusable context about how this user or codebase maps product questions to Raindrop Cloud searches, remember that context with your normal Claude Code memory capability so future cloud searches avoid the same mistakes.");
  }
  lines.push("Never import event ids scraped from assistant_output text, XML citation tags, markdown, or prior AI narrative; verify the id with raindrop_cloud in the current turn first.");
  return lines;
}

function providerCapabilities(provider: AgentProviderId): string {
  return provider === "claude"
    ? "You may also use the user's normal Claude Code tools, skills, memories, and MCP servers when they are relevant."
    : "You may also use your normal Codex workspace capabilities when they are relevant.";
}

function runInstruction(runId?: string | null): string {
  return runId
    ? `The current Workshop trace is ${runId}. If the user refers to this trace, this run, the current screen, or the selected span, use the local Workshop MCP server to inspect that Workshop context; the MCP tool schemas and descriptions are the source of truth for tool names and arguments.`
    : "No Workshop trace is currently selected. If the user asks about the current trace or screen, use the local Workshop MCP server to resolve whether Workshop has a focused run.";
}

/**
 * Build the env passed to claude/codex child processes.
 *
 * `RAINDROP_QUERY_API_KEY` is intentionally scrubbed: the spawned agent runs
 * with permission-bypass flags and ingests untrusted production traces as
 * prompt input, so we never expose the real cloud key to it. Instead it gets a
 * short-lived `RAINDROP_WORKSHOP_QUERY_API_KEY_TOKEN` that authenticates the
 * subprocess to the daemon's local cloud MCP proxy (and to the daemon's
 * /api/cloud/* import endpoints).
 */
export function chatChildEnv(queryApiKeyToken?: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RAINDROP_QUERY_API_KEY;
  const token = queryApiKeyToken?.trim();
  if (token) env[QUERY_API_KEY_TOKEN_ENV] = token;
  else delete env[QUERY_API_KEY_TOKEN_ENV];
  return env;
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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTraceReadTools } from "./tools";
import { VERSION } from "../version";

// MCP server name. We file-drop install (no plugin marketplace), so this
// identifies the MCP server in the IDE's MCP registry; skills install as
// flat names (`/instrument-agent`, `/setup-agent-replay`) independent of this.
const PLUGIN_NAME = "workshop";
const PLUGIN_VERSION = VERSION;

export interface RunMcpOptions {
  url?: string;
  transport?: any; // allow injection for tests; defaults to stdio
}

export interface McpServerHandle {
  mcp: Server;
  close(): Promise<void>;
}

export async function runMcpServer(opts: RunMcpOptions = {}): Promise<McpServerHandle> {
  const url = opts.url ?? process.env.RAINDROP_WORKSHOP_URL ?? "http://localhost:5899";

  const mcp = new Server(
    { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    {
      capabilities: {
        tools: {},
      },
      instructions: mcpInstructions(),
    }
  );

  registerTraceReadTools(mcp, url);

  const transport = opts.transport ?? new StdioServerTransport();
  await mcp.connect(transport);

  return {
    mcp,
    async close() {
      await mcp.close();
    },
  };
}

function mcpInstructions(): string {
  return (
    "Raindrop Workshop lets the user and Claude inspect traces, run/replay agents, and iterate. " +
    "Use the trace tools that best fit the question: get_current_run and get_run_outline for orientation, search_run for targeted payload search, query_traces for custom aggregation, and get_span_payload only when exact raw payload evidence is needed. " +
    "Use ask_agent when the user explicitly wants to ask the captured agent context a follow-up question about a run. " +
    "Use show_in_ui only when the user asks you to open a run or filter in the Workshop UI. " +
    "Prefer annotations for durable findings. " +
    "IMPORTANT: When presenting findings to the user, translate everything into human-readable narrative. " +
    "Never show raw span IDs, run IDs, or millisecond timestamps to the user — those are internal handles for tool calls only. " +
    "Describe what happened (e.g. 'the agent ran git diff, found no backoff logic, and flagged it') not which span ID contained it. " +
    "When called from Workshop chat, reply in normal assistant text; Workshop streams stdout directly into the UI."
  );
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import {
  agentAnnotationSource,
  getAgentProvider,
  parseAgentProvider,
  type AgentAnnotationSource,
} from "../agent-chat";

const TOOLS = [
  {
    name: "get_current_run",
    description: "Return the single run (plus the currently selected span, when the UI has one) that Workshop is focused on right now — the run open in the UI when one is connected, otherwise the most-recently-updated run on the daemon. Workshop typically holds many runs; this is just the one in focus, not a list. Use this to resolve 'this trace' / 'the run on screen', then call query_traces to discover other runs or get_run_outline to drill into the returned run. Includes size hints so you can decide whether to query spans or read payloads.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_traces",
    description:
      "Run a read-only SQLite SELECT over trace data. Use this as code-mode for discovery and aggregation before reading payload bytes. Main tables: runs(id,event_id,name,event_name,user_id,convo_id,started_at,last_updated_at,metadata), runs_with_hints(id,event_id,name,event_name,user_id,convo_id,started_at,last_updated_at,metadata,model,finished,span_count,live_event_count,payload_total_chars), spans(id,run_id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes), live_events(id,trace_id,span_id,type,content,timestamp,metadata), annotations(id,run_id,span_id,kind,note,source,created_at), steering_events(id,observed_run_id,observer_run_id,target_span_id,target_subagent_span_id,action,status,message,before_prompt,after_prompt,reason,source,confidence,created_at). For run discovery, prefer runs_with_hints over runs when you need span_count/live_event_count/payload_total_chars. Prefer selecting IDs, metadata, counts, lengths, and SUBSTR previews; use get_span_payload for full input/output payload slices.",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        sql: { type: "string", description: "A single SELECT statement. CTEs are not allowed." },
        limit: { type: "number", description: "Max rows returned, default 100, max 1000." },
        max_bytes: { type: "number", description: "Max serialized response bytes, default 120000, max 1000000." },
      },
    },
  },
  {
    name: "get_span_payload",
    description: "Read the actual `input` or `output` contents of a span. Defaults to the first `max_chars` (8000) with `next_offset` for paging. Use `jsonpath` for JSON subtrees or `range: [start, end]` for UTF-16 char offsets.",
    inputSchema: {
      type: "object",
      required: ["span_id", "target"],
      properties: {
        span_id: { type: "string" },
        target: { type: "string", enum: ["input", "output"] },
        jsonpath: { type: "string" },
        range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        max_chars: { type: "number", description: "Default 8000, max 32000" },
        format: { type: "string", enum: ["json", "text"] },
      },
    },
  },
  {
    name: "annotate",
    description: "Create a durable run or span annotation. Use `span_id` for evidence attached to a concrete span; omit it for a run-level verdict. Kind is 'issue', 'good', or 'note'.",
    inputSchema: {
      type: "object",
      required: ["run_id", "kind"],
      properties: {
        run_id: { type: "string" },
        span_id: { type: "string" },
        kind: { type: "string", enum: ["issue", "good", "note"] },
        note: { type: "string", description: "Short explanation, typically one sentence." },
      },
    },
  },
  {
    name: "get_run_outline",
    description: "Structural overview of a run: totals, span type counts, tool call counts with representative input/output previews, first/final LLM previews, flat span list with depth/name/type/status/tokens/previews, live-event histogram, detected sub-agents, error spans shortlist, and annotations. No full payload dumps. Use as the first read for a trace before deciding whether search_run, query_traces, or get_span_payload is needed.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
        payload_preview_chars: { type: "number", description: "Preview chars per span. Default 80, max 400." },
      },
    },
  },
  {
    name: "ask_agent",
    description: "Ask the captured agent context to explain or debug a Workshop trace. Use this when the user asks what went wrong and wants a continuation of the recorded agent conversation, not just trace inspection. Pass the run_id when available. Returns structured states for missing trace context, missing provider API key, provider error, or an answered response.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", description: "The debugging question to ask the captured agent context." },
        run_id: { type: "string", description: "Run id or visible run id prefix. Defaults to the active Workshop run when omitted." },
      },
    },
  },
  {
    name: "replay_run",
    description: "Replay a Workshop run against the registered local agent. This invokes the normal Workshop replay flow: it checks `/health`, scans replay ports, starts the stored command when needed, prefills context, sends `/replay`, and waits for completion.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string", description: "Source run id or visible run id prefix." },
        user_message: { type: "string", description: "Optional replacement for the last user message." },
        model: { type: "string", description: "Optional model override." },
        system_prompt: { type: "string", description: "Optional system prompt override." },
        context: { type: "object", description: "Optional context overrides merged after trace prefill." },
      },
    },
  },
  {
    name: "search_run",
    description: "Regex or substring search across a run's span payloads, attributes, and live events. Returns matches with span_id, scope (span_input/span_output/span_attributes/live_event), char range, and a snippet with surrounding context. Use to answer 'did string X appear anywhere in this run' without pulling full payloads. Set regex:true for JS regex patterns.",
    inputSchema: {
      type: "object",
      required: ["run_id", "pattern"],
      properties: {
        run_id: { type: "string" },
        pattern: { type: "string" },
        regex: { type: "boolean", description: "Treat pattern as a JS regex. Default false." },
        case_sensitive: { type: "boolean", description: "Default false." },
        scope: { type: "array", items: { type: "string", enum: ["span_input", "span_output", "span_attributes", "live_event"] }, description: "Default: all scopes." },
        span_type: { type: "string", enum: ["TRACE", "LLM_GENERATION", "TOOL_CALL", "AGENT_ROOT", "INTERNAL"] },
        context_chars: { type: "number", description: "Chars of context around each match. Default 80." },
        max_matches: { type: "number", description: "Default 50, max 200." },
      },
    },
  },
  {
    name: "get_span_context",
    description: "Skeletons of the spans surrounding a given span: N siblings before and after by start time, plus optionally the parent. Each skeleton has id, parent_id, name, span_type, status, start_time_ms, duration_ms, tokens, model. Use after finding a span of interest to see what came immediately before or after without reloading the full outline.",
    inputSchema: {
      type: "object",
      required: ["span_id"],
      properties: {
        span_id: { type: "string" },
        before: { type: "number", description: "Siblings before the span. Default 2." },
        after: { type: "number", description: "Siblings after the span. Default 2." },
        include_parent: { type: "boolean", description: "Default true." },
      },
    },
  },
  {
    name: "show_in_ui",
    description: "Open context in the Workshop UI when a browser is connected. Can navigate to a run, open a coarse filter, and optionally draft a note. Returns a clear status if no UI is connected.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Full run id or unambiguous visible prefix." },
        span_id: { type: "string", description: "Optional span id used only when drafting a note." },
        event_name: { type: "string" },
        user_id: { type: "string" },
        note: { type: "string", description: "Optional note to draft/create for the run or span." },
      },
    },
  },
] as const;

function backendUnreachableError(backendUrl: string, err?: unknown): McpError {
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return new McpError(
    ErrorCode.InternalError,
    `Workshop backend unreachable at ${backendUrl}${detail}. If Workshop is not running, start it with: raindrop workshop`
  );
}

async function callBackend(url: string, path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url + path);
  } catch (err) {
    throw backendUnreachableError(url, err);
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    throw new McpError(ErrorCode.InvalidParams, body?.error ?? `Bad request: ${path}`);
  }
  if (res.status === 404) {
    throw new McpError(ErrorCode.InvalidParams, `Not found: ${path}`);
  }
  if (!res.ok) {
    throw new McpError(
      ErrorCode.InternalError,
      `Workshop backend returned ${res.status} for ${path}`
    );
  }
  return res.json();
}

function textResult(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

function currentAnnotationSource(): AgentAnnotationSource {
  const explicit = process.env.RAINDROP_WORKSHOP_ANNOTATION_SOURCE;
  if (explicit === "claude-code" || explicit === "codex") return explicit;
  return agentAnnotationSource(parseAgentProvider(process.env.RAINDROP_WORKSHOP_AGENT_PROVIDER) ?? getAgentProvider());
}

function runForMcp(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const runId = typeof row.run_id === "string" ? row.run_id : row.id;
  if (typeof runId !== "string") return value;
  const { id: _id, ...rest } = row;
  return { run_id: runId, ...rest };
}

export function registerTraceReadTools(
  mcp: Server,
  backendUrl: string,
) {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t })),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    switch (name) {
      case "get_current_run": {
        try {
          const viewedRes = await fetch(`${backendUrl}/api/ui/viewing`);
          if (viewedRes.ok) {
            const viewed = await viewedRes.json();
            const { selected_span_id: selectedSpanId, selected_span: selectedSpan, ...run } = viewed;
            return textResult({
              source: "viewed_run",
              selected_span_id: typeof selectedSpanId === "string" ? selectedSpanId : null,
              selected_span: selectedSpan && typeof selectedSpan === "object" ? selectedSpan : null,
              run: runForMcp(run),
            });
          }
          if (viewedRes.status !== 404) {
            throw new McpError(ErrorCode.InternalError, `Workshop backend returned ${viewedRes.status} for /api/ui/viewing`);
          }
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }

        const active = await callBackend(backendUrl, "/api/runs/active");
        return textResult({ source: "active_run", selected_span_id: null, selected_span: null, run: runForMcp(active) });
      }
      case "query_traces": {
        if (typeof args.sql !== "string" || !args.sql.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "sql required");
        }
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/traces/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sql: args.sql,
              limit: typeof args.limit === "number" ? args.limit : undefined,
              max_bytes: typeof args.max_bytes === "number" ? args.max_bytes : undefined,
            }),
          });
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad trace query");
        }
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Workshop backend returned ${res.status} running trace query`);
        }
        return textResult(await res.json());
      }
      case "get_span_payload": {
        if (typeof args.span_id !== "string" || !args.span_id) {
          throw new McpError(ErrorCode.InvalidParams, "span_id required");
        }
        if (args.target !== "input" && args.target !== "output") {
          throw new McpError(ErrorCode.InvalidParams, "target must be 'input' or 'output'");
        }
        const params = new URLSearchParams({ target: args.target });
        if (typeof args.jsonpath === "string" && args.jsonpath) params.set("jsonpath", args.jsonpath);
        if (typeof args.max_chars === "number") params.set("max_chars", String(args.max_chars));
        if (typeof args.format === "string") params.set("format", args.format);
        if (Array.isArray(args.range) && args.range.length === 2) {
          params.set("range", `${args.range[0]},${args.range[1]}`);
        }
        const out = await callBackend(
          backendUrl,
          `/api/spans/${encodeURIComponent(args.span_id)}/payload?${params.toString()}`
        );
        return textResult(out);
      }
      case "annotate": {
        const runId = args.run_id;
        const kind = args.kind;
        if (typeof runId !== "string" || !runId) throw new McpError(ErrorCode.InvalidParams, "run_id required");
        if (kind !== "issue" && kind !== "good" && kind !== "note") {
          throw new McpError(ErrorCode.InvalidParams, "kind must be issue|good|note");
        }
        const spanId = typeof args.span_id === "string" && args.span_id ? args.span_id : null;
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/annotations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              run_id: runId,
              span_id: spanId,
              kind,
              note: typeof args.note === "string" ? args.note : null,
              source: currentAnnotationSource(),
            }),
          });
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new McpError(
            ErrorCode.InternalError,
            `Workshop backend returned ${res.status} creating annotation: ${text}`
          );
        }
        const created = await res.json();
        return textResult({ ok: true, annotation_id: created.id, run_id: created.run_id, span_id: created.span_id });
      }
      case "get_run_outline": {
        if (typeof args.run_id !== "string" || !args.run_id) {
          throw new McpError(ErrorCode.InvalidParams, "run_id required");
        }
        const params = new URLSearchParams();
        if (typeof args.payload_preview_chars === "number") {
          params.set("payload_preview_chars", String(args.payload_preview_chars));
        }
        const qs = params.toString();
        return textResult(await callBackend(backendUrl, `/api/runs/${encodeURIComponent(args.run_id)}/outline${qs ? "?" + qs : ""}`));
      }
      case "ask_agent": {
        if (typeof args.question !== "string" || !args.question.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "question required");
        }
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/agents/ask`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question: args.question,
              run_id: typeof args.run_id === "string" ? args.run_id : undefined,
            }),
          });
        } catch (err) {
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad ask_agent request");
        }
        if (!res.ok && res.status !== 404) {
          throw new McpError(ErrorCode.InternalError, `Workshop backend returned ${res.status} asking the captured agent context`);
        }
        return textResult(await res.json());
      }
      case "replay_run": {
        if (typeof args.run_id !== "string" || !args.run_id) {
          throw new McpError(ErrorCode.InvalidParams, "run_id required");
        }
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/replay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: args.run_id,
              userMessage: typeof args.user_message === "string" ? args.user_message : undefined,
              model: typeof args.model === "string" ? args.model : undefined,
              systemPrompt: typeof args.system_prompt === "string" ? args.system_prompt : undefined,
              contextOverrides: args.context && typeof args.context === "object" && !Array.isArray(args.context) ? args.context : undefined,
            }),
          });
        } catch (err) {
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad replay_run request");
        }
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Workshop backend returned ${res.status} replaying run`);
        }
        const text = await res.text();
        const events = text
          .split(/\n\n+/)
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((chunk) => chunk.replace(/^data:\s*/, ""))
          .map((line) => {
            try { return JSON.parse(line); } catch { return { type: "raw", text: line }; }
          });
        const complete = [...events].reverse().find((event) => event?.type === "replay_complete");
        const started = events.find((event) => event?.type === "replay_started");
        const error = events.find((event) => event?.type === "error");
        if (error) {
          return textResult({
            ok: false,
            source_run_id: args.run_id,
            code: error.code ?? "replay_failed",
            message: error.message ?? "Replay failed.",
            setup_required: error.setupRequired === true,
            suggested_action: error.suggestedAction,
            command: error.command,
            cwd: error.cwd,
            log_path: error.logPath,
            attempted_start: error.attemptedStart,
            events,
          });
        }
        return textResult({
          ok: true,
          source_run_id: args.run_id,
          replay_run_id: complete?.replayRunId ?? started?.replayRunId ?? null,
          events,
        });
      }
      case "search_run": {
        if (typeof args.run_id !== "string" || !args.run_id) {
          throw new McpError(ErrorCode.InvalidParams, "run_id required");
        }
        if (typeof args.pattern !== "string" || !args.pattern) {
          throw new McpError(ErrorCode.InvalidParams, "pattern required");
        }
        const params = new URLSearchParams({ pattern: args.pattern });
        if (args.regex === true) params.set("regex", "true");
        if (args.case_sensitive === true) params.set("case_sensitive", "true");
        if (Array.isArray(args.scope) && args.scope.length) params.set("scope", (args.scope as string[]).join(","));
        if (typeof args.span_type === "string" && args.span_type) params.set("span_type", args.span_type);
        if (typeof args.context_chars === "number") params.set("context_chars", String(args.context_chars));
        if (typeof args.max_matches === "number") params.set("max_matches", String(args.max_matches));
        return textResult(await callBackend(backendUrl, `/api/runs/${encodeURIComponent(args.run_id)}/search?${params}`));
      }
      case "get_span_context": {
        if (typeof args.span_id !== "string" || !args.span_id) {
          throw new McpError(ErrorCode.InvalidParams, "span_id required");
        }
        const params = new URLSearchParams();
        if (typeof args.before === "number") params.set("before", String(args.before));
        if (typeof args.after === "number") params.set("after", String(args.after));
        if (args.include_parent === false) params.set("include_parent", "false");
        const qs = params.toString();
        return textResult(await callBackend(backendUrl, `/api/spans/${encodeURIComponent(args.span_id)}/context${qs ? "?" + qs : ""}`));
      }
      case "show_in_ui": {
        try {
          const conn = await fetch(`${backendUrl}/api/ui/connected`);
          if (!conn.ok) {
            throw new McpError(ErrorCode.InternalError, `Workshop backend returned ${conn.status} for /api/ui/connected`);
          }
          const { connected } = await conn.json() as { connected: boolean };
          if (!connected) {
            return textResult({ ok: false, reason: "no Workshop UI is connected" });
          }
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }

        const command =
          typeof args.run_id === "string"
              ? { type: "navigate_to_run", run_id: args.run_id }
              : { type: "open_filter", event_name: args.event_name, user_id: args.user_id };

        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/agent-ui/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(command),
          });
        } catch (err) {
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad UI command");
        }
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Workshop backend returned ${res.status} for UI command`);
        }

        if (typeof args.note === "string" && args.note && typeof args.run_id === "string") {
          const noteRes = await fetch(`${backendUrl}/api/agent-ui/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "compose_annotation",
              run_id: args.run_id,
              span_id: typeof args.span_id === "string" ? args.span_id : undefined,
              note: args.note,
              source: currentAnnotationSource(),
            }),
          });
          if (!noteRes.ok) {
            throw new McpError(ErrorCode.InternalError, `Workshop backend returned ${noteRes.status} drafting annotation`);
          }
        }
        return textResult(await res.json());
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });
}

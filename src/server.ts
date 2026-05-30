import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import type { AddressInfo } from "net";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { normalizeOtelId } from "./ids";
import { parseOtlpRequest } from "./parse";
import { decodeOtlpProtobuf } from "./otlp-protobuf";
import { upsertRun, insertSpan, upsertEventSpan, findRunByEventId, adoptRunByEventId, getRuns, getRunWithSpans, getRunsByConvoId, clearAll, upsertLiveEvent, getLiveEvents, cacheSavedRun, getCachedRun, deleteCachedRun, deleteRun, getSpanMeta, getSpanById, getSpanPayloadColumn, getSpanContext, getMostRecentlyTouchedRun, getRunById, getRunOutline, listSpansFiltered, searchRun, tailLiveEvents, listSavedEvents, getSavedEvent, upsertSavedEvent, patchSavedEvent, deleteSavedEvent, listSavedFolders, ensureSavedFolder, deleteSavedFolder, queryTraces, getObserverRunsForObservedRun, type SavedEventRow } from "./db";
import { sliceSpanPayload } from "./payload-slice";
import { detectSubAgents } from "./agents";
import { applyProviderOptions, detectProvider, getProviderBaseURL, getProviderHeaders } from "./provider-options";
import { runReplay } from "./replay";
import { discoverReplayAgents, loadAgentsConfig, saveAgentsConfig, extractContextFromTrace, registerReplayProjectIfPresent } from "./agents-config";
import { resolveBuiltAppDir } from "./ui-assets";
import { setReplayTrace } from "./replay-map";
import { getClaudeSession, getLatestClaudeLoadout, listClaudeSessions, type ClaudeLoadout } from "./claude-sessions";
import { getCodexSession, listCodexSessions } from "./codex-sessions";
import { runClaudeCliChat } from "./claude-cli-chat";
import { runCodexCliChat } from "./codex-cli-chat";
import {
  agentAnnotationSource,
  agentProviderLabel,
  defaultAgentLoadout,
  getAgentProvider,
  parseAgentProvider,
  setAgentProvider,
  type AgentProviderId,
} from "./agent-chat";
import { loadInstallRegistry } from "./install/registry";
import {
  ACTIVE_WORKSPACE_MISSING_MESSAGE,
  type ActiveWorkspace,
  getActiveWorkspace,
  setActiveWorkspace,
} from "./active-workspace";
import {
  AskUserQuestionBridge,
  askUserQuestionAllow,
  askUserQuestionDeny,
  parseAnswerMap,
  parseAskUserQuestionHookInput,
} from "./claude-ask-user-question";
import { createViewingRegistry } from "./viewing-registry";
import { isLoopbackRemoteAddress } from "./local-access";
import {
  createAnnotation,
  deleteAnnotation,
  getAnnotationsByRun,
  AnnotationNotFoundError,
  InvalidAnnotationError,
  type AnnotationKind,
  type AnnotationSource,
} from "./annotations";
import {
  createSteeringEvent,
  listObserverRunsForRun,
  listSteeringEventsForRun,
  InvalidSteeringEventError,
  type SteeringAction,
  type SteeringStatus,
} from "./steering";
import { replayDefaultDemoTraces } from "./demo-traces";

function parseAnnotationSource(value: unknown): AnnotationSource | null {
  return value === "user" || value === "claude-code" || value === "codex" ? value : null;
}

function bodyString(body: Record<string, unknown>, snake: string, camel = snake): string | undefined {
  const value = body[snake] ?? body[camel];
  return typeof value === "string" ? value : undefined;
}

function getStringMetadata(
  metadata: unknown,
  key: string
): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function getTraceIdFromPartialEvent(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const aiData = b.ai_data;
  if (aiData && typeof aiData === "object") {
    const v = (aiData as Record<string, unknown>).trace_id;
    if (typeof v === "string" && v) return normalizeOtelId(v, 16) ?? v;
  }
  const properties = b.properties;
  if (properties && typeof properties === "object") {
    const props = properties as Record<string, unknown>;
    const v = typeof props.trace_id === "string" && props.trace_id
      ? props.trace_id
      : typeof props.$trace_id === "string" && props.$trace_id
        ? props.$trace_id
        : undefined;
    if (v) return normalizeOtelId(v, 16) ?? v;
  }
  return undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hostHeaderName(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  return host.split(":")[0];
}

function isAllowedLocalHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function isAllowedLocalAccess(hostHeader: string | string[] | undefined, originHeader: string | string[] | undefined): boolean {
  const host = firstHeader(hostHeader) ?? "";
  const hostName = hostHeaderName(host);
  if (hostName && !isAllowedLocalHostname(hostName)) return false;

  const origin = firstHeader(originHeader);
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return isAllowedLocalHostname(u.hostname);
  } catch {
    return false;
  }
}

function allowedIngestCorsOrigin(originHeader: string | string[] | undefined): string | null {
  const origin = firstHeader(originHeader);
  if (!origin) return null;
  try {
    const u = new URL(origin);
    return isAllowedLocalHostname(u.hostname) || u.protocol === "chrome-extension:" ? origin : null;
  } catch {
    return null;
  }
}

const DEMO_CHAT_MODEL = process.env.RAINDROP_DEMO_CHAT_MODEL ?? "gpt-5.5-nano";

type DemoChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function parseDemoMessages(value: unknown): DemoChatMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: DemoChatMessage[] = [];
  for (const item of value.slice(-16)) {
    if (!item || typeof item !== "object") continue;
    const role = (item as Record<string, unknown>).role;
    const content = (item as Record<string, unknown>).content;
    if (
      (role === "system" || role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.trim()
    ) {
      messages.push({ role, content: content.trim().slice(0, 8000) });
    }
  }
  return messages.some((message) => message.role === "user") ? messages : null;
}

function extractOpenAiTextDelta(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  const chatDelta = payload.choices?.[0]?.delta?.content;
  if (typeof chatDelta === "string") return chatDelta;
  return "";
}

async function streamOpenAiDemoChat(req: express.Request, res: express.Response): Promise<void> {
  const messages = parseDemoMessages((req.body as Record<string, unknown> | null)?.messages);
  if (!messages) {
    res.status(400).json({ error: "messages must include at least one user message" });
    return;
  }

  const clientKey = req.header("x-rd-openai-key")?.trim();
  const apiKey = clientKey || process.env.OPENAI_API_KEY || process.env.RAINDROP_OPENAI_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: "No OpenAI API key. Add one in Workshop Settings or set OPENAI_API_KEY." });
    return;
  }

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEMO_CHAT_MODEL,
      instructions:
        "You are the tiny Workshop demo bot. Be warm, concise, and explain how Raindrop Workshop helps debug AI agents with local traces.",
      input: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: true,
    }),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    res.status(upstream.status).json({ error: text || `OpenAI request failed (${upstream.status})` });
    return;
  }

  const reader = (upstream.body as any)?.getReader?.();
  if (!reader) {
    res.status(502).json({ error: "OpenAI response did not include a readable stream." });
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        for (const data of dataLines) {
          if (!data || data === "[DONE]") continue;
          try {
            const payload = JSON.parse(data);
            const delta = extractOpenAiTextDelta(payload);
            if (delta) res.write(delta);
          } catch {
            /* Ignore non-JSON stream control frames. */
          }
        }
      }
    }
  } finally {
    try { await reader.cancel?.(); } catch {}
    res.end();
  }
}

function demoChatHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Workshop Demo Chat</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 50% 0%, rgba(91,141,239,.28), transparent 36%),
        radial-gradient(circle at 10% 90%, rgba(79,202,227,.14), transparent 32%),
        #000;
      color: #e1e8ec;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .shell {
      width: min(720px, calc(100vw - 28px));
      height: min(760px, calc(100vh - 28px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 28px;
      background: rgba(5, 8, 12, .82);
      box-shadow: 0 32px 90px rgba(0,0,0,.5), 0 0 80px rgba(91,141,239,.16);
      backdrop-filter: blur(18px);
    }
    header { padding: 22px 24px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
    h1 { margin: 0; font-size: 22px; letter-spacing: -.03em; }
    .sub { margin-top: 6px; color: #7d8a90; font-size: 13px; line-height: 1.5; }
    .model { color: #c8d5dc; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    main { flex: 1; overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 82%; padding: 12px 14px; border-radius: 18px; white-space: pre-wrap; line-height: 1.55; font-size: 14px; }
    .user { align-self: flex-end; background: rgba(91,141,239,.23); border: 1px solid rgba(91,141,239,.32); color: #f2f5f7; }
    .assistant { align-self: flex-start; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.09); color: #dce6eb; }
    .error { align-self: center; color: #ffb4b4; border: 1px solid rgba(235,20,20,.24); background: rgba(235,20,20,.10); }
    form { display: flex; gap: 10px; padding: 14px; border-top: 1px solid rgba(255,255,255,.08); }
    textarea {
      flex: 1;
      min-height: 48px;
      max-height: 140px;
      resize: vertical;
      color: #f2f5f7;
      background: rgba(0,0,0,.38);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 16px;
      padding: 13px 14px;
      outline: none;
      font: inherit;
    }
    textarea:focus { border-color: rgba(91,141,239,.72); box-shadow: 0 0 0 3px rgba(91,141,239,.18); }
    button {
      border: 1px solid rgba(91,141,239,.36);
      border-radius: 16px;
      background: rgba(91,141,239,.24);
      color: #f2f5f7;
      padding: 0 18px;
      font-weight: 650;
      cursor: pointer;
    }
    button:disabled { opacity: .45; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <h1>Workshop Demo Chat</h1>
      <div class="sub">A tiny standalone bot streamed through OpenAI <span class="model">${DEMO_CHAT_MODEL}</span>. It uses your saved Workshop OpenAI key when available.</div>
    </header>
    <main id="log">
      <div class="msg assistant">Hi, I’m the Workshop demo bot. Ask me what a trace is, or how Workshop helps debug an agent locally.</div>
    </main>
    <form id="form">
      <textarea id="input" placeholder="Ask the demo bot..." autofocus></textarea>
      <button id="send" type="submit">Send</button>
    </form>
  </div>
  <script>
    const log = document.getElementById("log");
    const form = document.getElementById("form");
    const input = document.getElementById("input");
    const send = document.getElementById("send");
    const messages = [{ role: "assistant", content: "Hi, I’m the Workshop demo bot. Ask me what a trace is, or how Workshop helps debug an agent locally." }];

    function add(role, text) {
      const el = document.createElement("div");
      el.className = "msg " + role;
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      send.disabled = true;
      messages.push({ role: "user", content: text });
      add("user", text);
      const assistant = add("assistant", "");
      try {
        const res = await fetch("/api/demo-chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-rd-openai-key": localStorage.getItem("rd_openai_key") || "",
          },
          body: JSON.stringify({ messages }),
        });
        if (!res.ok || !res.body) {
          const err = await res.text();
          throw new Error(err || "Demo request failed.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let reply = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reply += decoder.decode(value, { stream: true });
          assistant.textContent = reply || "…";
          log.scrollTop = log.scrollHeight;
        }
        messages.push({ role: "assistant", content: reply });
      } catch (err) {
        assistant.remove();
        add("error", err instanceof Error ? err.message : String(err));
      } finally {
        send.disabled = false;
        input.focus();
      }
    });
  </script>
</body>
</html>`;
}

export async function createServer(port: number) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, done) => {
      done(
        isLoopbackRemoteAddress(info.req.socket.remoteAddress) &&
          isAllowedLocalAccess(info.req.headers.host, info.origin || info.req.headers.origin),
        403,
        "Forbidden",
      );
    },
  });

  const clients = new Set<WebSocket>();

  function broadcast(event: string, data: any) {
    const msg = JSON.stringify({ event, data });
    for (const ws of clients) { if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
  }

  const askUserQuestions = new AskUserQuestionBridge(broadcast);
  let agentProvider: AgentProviderId = getAgentProvider();
  let latestClaudeLoadout: ClaudeLoadout | null = null;

  const viewingRegistry = createViewingRegistry();
  const ANTHROPIC_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
  let anthropicModelsCache: { expiresAt: number; models: string[] } | null = null;
  const claudeCliChatEnabled =
    port !== 0 && process.env.RAINDROP_WORKSHOP_CLAUDE_CLI_CHAT !== "0";

  function backendUrl(): string {
    const addr = server.address() as AddressInfo | null;
    return `http://127.0.0.1:${addr?.port ?? port}`;
  }

  function activeWorkspaceOrError(res: express.Response): ActiveWorkspace | null {
    const workspace = getActiveWorkspace();
    if (workspace) return workspace;
    res.status(409).json({ error: ACTIVE_WORKSPACE_MISSING_MESSAGE });
    return null;
  }

  function rememberClaudeLoadout(event: unknown) {
    if (!event || typeof event !== "object") return;
    const typed = event as Record<string, unknown>;
    if (typed.type !== "loadout") return;
    const tools = stringList(typed.tools);
    const mcps = stringList(typed.mcps);
    const skills = stringList(typed.skills);
    const plugins = stringList(typed.plugins);
    const slashCommands = stringList(typed.slash_commands);
    latestClaudeLoadout = {
      tools: tools.length ? tools : latestClaudeLoadout?.tools ?? [],
      mcps: mcps.length ? mcps : latestClaudeLoadout?.mcps ?? [],
      skills: skills.length ? skills : latestClaudeLoadout?.skills ?? [],
      plugins: plugins.length ? plugins : latestClaudeLoadout?.plugins ?? [],
      slash_commands: slashCommands.length ? slashCommands : latestClaudeLoadout?.slash_commands ?? [],
      model: typeof typed.model === "string" ? typed.model : undefined,
    };
    broadcast("claude_loadout", latestClaudeLoadout);
    broadcast("agent_loadout", latestClaudeLoadout);
  }

  function currentLoadout(workspace: ActiveWorkspace) {
    if (agentProvider === "codex") return defaultAgentLoadout("codex");
    if (!latestClaudeLoadout) {
      latestClaudeLoadout = getLatestClaudeLoadout(workspace.cwd);
    }
    return latestClaudeLoadout ?? defaultAgentLoadout("claude");
  }

  wss.on("connection", (ws) => {
    const wsId = randomUUID();
    clients.add(ws);
    if (latestClaudeLoadout) {
      ws.send(JSON.stringify({ event: "claude_loadout", data: latestClaudeLoadout }));
    }
    ws.send(JSON.stringify({ event: "agent_provider", data: { provider: agentProvider } }));
    const workspace = getActiveWorkspace();
    if (workspace) {
      ws.send(JSON.stringify({ event: "agent_loadout", data: currentLoadout(workspace) }));
    }
    for (const pending of askUserQuestions.active()) {
      ws.send(JSON.stringify({ event: "claude_ask_user_question", data: pending }));
    }
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ui_view") {
        const runId = typeof msg.run_id === "string" && msg.run_id ? msg.run_id : null;
        const selectedSpanId = typeof msg.span_id === "string" && msg.span_id ? msg.span_id : null;
        viewingRegistry.update(wsId, runId, selectedSpanId);
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      viewingRegistry.unregister(wsId);
    });
  });

  const INGEST_PATHS = new Set([
    "/v1/traces",
    "/v1/otel/v1/traces",
    "/otel/v1/traces",
    "/v1/live",
    "/v1/events/track",
    "/v1/events/track_partial",
    "/v1/users/identify",
    "/v1/signals/track",
  ]);

  // Workshop is a local control plane. Enforce loopback at the socket layer so
  // spoofable Host/Origin headers cannot turn a broad listener into LAN access.
  app.use((req, res, next) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });

  // CORS for the ingestion routes browser SDKs actually post to —
  // narrower than `/v1/*` so future routes under that prefix don't
  // inherit cross-origin access by default.
  app.use(
    [...INGEST_PATHS],
    (req, res, next) => {
      const origin = firstHeader(req.headers.origin);
      const corsOrigin = allowedIngestCorsOrigin(req.headers.origin);
      if (!isAllowedLocalAccess(req.headers.host, undefined) || (origin && !corsOrigin)) {
        return res.status(403).json({ error: "forbidden" });
      }
      if (corsOrigin) res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    },
  );

  // Block cross-origin requests to everything except the ingestion routes
  // (handled above). Non-browser callers (MCP stdio, curl, local SDKs) don't
  // send Origin/Host so they pass through unaffected.
  app.use((req, res, next) => {
    if (INGEST_PATHS.has(req.path)) return next();
    if (!isAllowedLocalAccess(req.headers.host, req.headers.origin)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));
  // Accept protobuf bodies so Traceloop OTLP exports aren't silently dropped
  app.use(express.raw({ limit: "50mb", type: "application/x-protobuf" }));

  server.on("close", () => {
    askUserQuestions.closeAll();
  });

  // Health check endpoint — used by SDKs to auto-detect a running debugger
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "workshop", port, pid: process.pid });
  });

  app.get("/demo-chat", (_req, res) => {
    res.type("html").send(demoChatHtml());
  });

  app.post("/api/demo-chat", (req, res) => {
    streamOpenAiDemoChat(req, res).catch((err) => {
      console.error("[workshop] demo chat error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message || "Demo chat failed." });
        return;
      }
      res.write(`\n[demo chat error: ${(err as Error).message || String(err)}]`);
      res.end();
    });
  });

  app.post("/api/demo-traces/replay", (_req, res) => {
    try {
      const result = replayDefaultDemoTraces({ broadcast });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[workshop] demo trace replay failed:", err);
      res.status(500).json({ error: (err as Error).message || "Failed to replay demo traces." });
    }
  });

  // Shared OTLP trace ingestion handler
  function ingestTraces(req: any, res: any) {
    try {
      let body = req.body;
      if (Buffer.isBuffer(body)) {
        try {
          body = decodeOtlpProtobuf(body);
        } catch (err) {
          console.error("[workshop] Failed to decode protobuf OTLP:", err);
          res.status(400).json({ error: "Failed to decode protobuf OTLP body" });
          return;
        }
      }
      const spans = parseOtlpRequest(body);
      if (spans.length === 0) { res.json({ ok: true, spansIngested: 0 }); return; }

      const byTrace = new Map<string, typeof spans>();
      for (const s of spans) { const a = byTrace.get(s.traceId) ?? []; a.push(s); byTrace.set(s.traceId, a); }

      const updatedRunIds: string[] = [];
      for (const [traceId, traceSpans] of byTrace) {
        const now = Date.now();
        const minStart = Math.min(...traceSpans.map(s => s.startTimeMs));
        const maxEnd = Math.max(...traceSpans.map(s => s.endTimeMs));
        const root = traceSpans.find(s => !s.parentSpanId) ?? traceSpans[0];

        // Record mapping if this trace carries a replayRunId so the
        // replay system can find this run by its replayRunId
        const replayRunId = traceSpans.find(s => s.replayRunId)?.replayRunId;
        if (replayRunId) {
          setReplayTrace(replayRunId, traceId);
        }

        const eventId = traceSpans.find(s => s.eventId)?.eventId;

        upsertRun({
          id: traceId, event_id: eventId,
          name: root?.name ?? traceId.slice(0, 8),
          event_name: traceSpans.find(s => s.eventName)?.eventName,
          user_id: traceSpans.find(s => s.userId)?.userId,
          convo_id: traceSpans.find(s => s.convoId)?.convoId,
          started_at: minStart || now, last_updated_at: maxEnd || now,
        });
        if (eventId) adoptRunByEventId(eventId, traceId);

        for (const s of traceSpans) {
          insertSpan({
            id: s.spanId, run_id: traceId, parent_span_id: s.parentSpanId,
            name: s.name, span_type: s.spanType, status: s.status,
            input_payload: s.inputPayload, output_payload: s.outputPayload,
            start_time_ms: s.startTimeMs, end_time_ms: s.endTimeMs, duration_ms: s.durationMs,
            model: s.model, provider: s.provider,
            input_tokens: s.inputTokens, output_tokens: s.outputTokens,
            attributes: JSON.stringify(s.attributes),
          });
        }

        if (eventId && minStart) {
          const synth = getSpanById(`evt_${eventId}`);
          if (synth) {
            upsertEventSpan({
              id: synth.id,
              run_id: traceId,
              name: synth.name,
              span_type: synth.span_type ?? undefined,
              start_time_ms: minStart,
              end_time_ms: maxEnd,
              duration_ms: maxEnd - minStart,
            });
          }
        }
        updatedRunIds.push(traceId);
      }

      broadcast("spans", { runIds: updatedRunIds, count: spans.length });
      res.json({ ok: true, spansIngested: spans.length });
    } catch (err) {
      console.error("[workshop] Error ingesting:", err);
      res.status(500).json({ error: "Failed to ingest" });
    }
  }

  // Accept OTLP trace exports at multiple paths to handle various SDK exporters
  // (direct shipper, Traceloop, standard OTLP exporters)
  app.post("/v1/traces", ingestTraces);
  app.post("/v1/otel/v1/traces", ingestTraces);
  app.post("/otel/v1/traces", ingestTraces);

  app.post("/v1/live", (req, res) => {
    try {
      const { traceId, spanId, type, content, timestamp, metadata } = req.body;
      const normalizedTraceId =
        typeof traceId === "string" ? normalizeOtelId(traceId, 16) ?? traceId : undefined;
      const normalizedSpanId =
        typeof spanId === "string" ? normalizeOtelId(spanId, 8) ?? spanId : undefined;
      if (!normalizedTraceId || !type) { res.status(400).json({ error: "traceId and type required" }); return; }
      if ((type === "tool_start" || type === "tool_result") && !normalizedSpanId) {
        res.status(400).json({ error: "spanId is required for tool_start and tool_result live events" });
        return;
      }
      const ts = timestamp ?? Date.now();
      const eventId =
        getStringMetadata(metadata, "eventId") ??
        getStringMetadata(metadata, "event_id");

      upsertLiveEvent({
        traceId: normalizedTraceId,
        spanId: normalizedSpanId,
        type,
        content,
        timestamp: ts,
        metadata,
      });
      upsertRun({
        id: normalizedTraceId,
        event_id: eventId,
        event_name: getStringMetadata(metadata, "eventName"),
        user_id: getStringMetadata(metadata, "userId"),
        convo_id: getStringMetadata(metadata, "convoId"),
        started_at: ts,
        last_updated_at: ts,
      });
      if (eventId) adoptRunByEventId(eventId, normalizedTraceId);
      broadcast("live", {
        traceId: normalizedTraceId,
        spanId: normalizedSpanId,
        type,
        content,
        timestamp: ts,
        metadata,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[workshop] Error:", err);
      res.status(500).json({ error: "Failed" });
    }
  });

  // Accept Raindrop event endpoints in local-only workflows so example apps can
  // point their SDK endpoint at the debugger without a real backend.
  app.post("/v1/events/track_partial", (req, res) => {
    const body = req.body ?? {};
    const traceId = getTraceIdFromPartialEvent(body);
    const eventId =
      typeof body.eventId === "string"
        ? body.eventId
        : typeof body.event_id === "string"
          ? body.event_id
          : undefined;

    // Resolve which run owns this partial event.
    // Priority: trace_id (from finish) > existing run looked up by event_id > new run keyed by event_id.
    // OTLP ingest calls adoptRunByEventId to merge event_id-keyed runs into the real trace.
    const existingRun = eventId ? findRunByEventId(eventId) : null;
    const runId = traceId ?? existingRun?.id ?? eventId;
    if (!runId) { res.json({ success: true }); return; }

    const now = Date.now();
    const aiData = body.ai_data && typeof body.ai_data === "object" ? body.ai_data : undefined;

    // Merge `body.properties` into `runs.metadata` so SDKs that surface
    // model / system_prompt / experiment / etc. via partial-event properties
    // (e.g. python-sdk's `interaction.set_properties({"model": ...})`
    // workaround when the `model=` kwarg isn't exposed) actually land in
    // the Workshop run's metadata column instead of being silently dropped.
    let metadataJson: string | undefined;
    const incomingProps =
      body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
        ? (body.properties as Record<string, unknown>)
        : undefined;
    if (incomingProps) {
      const existing = (getRunById(runId) as { metadata?: string | null } | null)?.metadata;
      let base: Record<string, unknown> = {};
      if (typeof existing === "string" && existing) {
        try {
          const parsed = JSON.parse(existing);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            base = parsed as Record<string, unknown>;
          }
        } catch { /* ignore stale non-JSON */ }
      }
      metadataJson = JSON.stringify({ ...base, ...incomingProps });
    }

    upsertRun({
      id: runId,
      event_id: eventId,
      name: aiData?.model ?? undefined,
      event_name:
        typeof body.event === "string"
          ? body.event
          : typeof body.event_name === "string"
            ? body.event_name
            : undefined,
      user_id:
        typeof body.userId === "string"
          ? body.userId
          : typeof body.user_id === "string"
            ? body.user_id
            : undefined,
      convo_id:
        aiData?.convo_id ??
        (typeof body.convoId === "string"
          ? body.convoId
          : typeof body.convo_id === "string"
            ? body.convo_id
            : undefined),
      started_at: now,
      last_updated_at: now,
      metadata: metadataJson,
    });
    if (traceId && eventId) adoptRunByEventId(eventId, traceId);

    if (aiData && eventId) {
      const input = typeof aiData.input === "string" ? aiData.input : aiData.input != null ? JSON.stringify(aiData.input) : null;
      const output = typeof aiData.output === "string" ? aiData.output : aiData.output != null ? JSON.stringify(aiData.output) : null;
      if (input || output) {
        // Anchor the synthetic span to the run's earliest known start so it
        // spans the whole interaction. ChatFlow times the user-message bubble
        // at this span's start; without anchoring, fast turns (where the SDK
        // flushes a single partial at finish() rather than one at begin()
        // and one at finish()) would park the span at the trailing edge and
        // sort the user message after the tool calls it preceded.
        const runStartedAt = getRunById(runId)?.started_at ?? now;
        const start = Math.min(runStartedAt, now);
        upsertEventSpan({
          id: `evt_${eventId}`,
          run_id: runId,
          name: aiData.model ?? "claude_code_session",
          span_type: "LLM",
          status: body.is_pending === false ? "OK" : "UNSET",
          input_payload: input ?? undefined,
          output_payload: output ?? undefined,
          start_time_ms: start,
          end_time_ms: now,
          duration_ms: Math.max(0, now - start),
          model: aiData.model ?? undefined,
        });
        broadcast("spans", { runIds: [runId], count: 1 });
      }
    }
    res.json({ success: true });
  });

  app.post("/v1/events/track", (_req, res) => {
    res.json({ success: true });
  });

  // Accept-and-discard handlers for `/v1/users/identify` and
  // `/v1/signals/track` so SDKs that emit user-trait + signal payloads
  // (Python, Rust, Go, the legacy js-sdk) stop hitting 404s in local-only
  // mode and triggering retry storms. Workshop doesn't render users or
  // signals yet — these stubs are the minimum to unbreak the wire.
  app.post("/v1/users/identify", (_req, res) => {
    res.json({ success: true });
  });
  app.post("/v1/signals/track", (_req, res) => {
    res.json({ success: true });
  });

  app.get("/api/runs", (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 5000) : 5000;
    res.json(getRuns(limit));
  });
  app.get("/api/runs/active", (_req, res) => {
    const run = getMostRecentlyTouchedRun();
    if (!run) { res.status(404).json({ error: "No runs yet" }); return; }
    res.json(run);
  });
  app.post("/api/traces/query", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    if (typeof body.sql !== "string" || !body.sql.trim()) {
      res.status(400).json({ error: "sql required" });
      return;
    }
    try {
      res.json(queryTraces(body.sql, {
        limit: typeof body.limit === "number" ? body.limit : undefined,
        maxBytes: typeof body.max_bytes === "number" ? body.max_bytes : undefined,
      }));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  app.get("/api/ui/connected", (_req, res) => {
    let connected = false;
    for (const ws of clients) { if (ws.readyState === WebSocket.OPEN) { connected = true; break; } }
    res.json({ connected });
  });
  app.get("/api/ui/viewing", (_req, res) => {
    const view = viewingRegistry.getMostRecentView();
    if (!view || !view.run_id) { res.status(404).json({ error: "No UI reporting a view" }); return; }
    // Hydrate with the run row + size hints so MCP get_current_run can size the trace upfront.
    // Fall back to the minimal shape if the registry knows the run_id but the row hasn't been
    // inserted yet (race during stream startup). Always include `run_id` so callers don't have
    // to branch on response shape.
    const run = getRunById(view.run_id) as any;
    const selectedSpan = view.selected_span_id ? getSpanById(view.selected_span_id) : null;
    const selected_span = selectedSpan?.run_id === view.run_id ? selectedSpan : null;
    if (run) { res.json({ ...run, run_id: view.run_id, selected_span_id: view.selected_span_id, selected_span, ts: view.ts }); return; }
    res.json({ run_id: view.run_id, selected_span_id: view.selected_span_id, selected_span, ts: view.ts });
  });
  app.post("/api/agent-ui/commands", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const command = canonicalizeAgentUiCommand(body as Record<string, unknown>);
    if (!command) {
      res.status(400).json({ error: "Unknown or ambiguous run_id" });
      return;
    }
    if (
      command.type === "compose_annotation" &&
      typeof command.run_id === "string" &&
      typeof command.note === "string"
    ) {
      try {
        const annotation = createAnnotation({
          run_id: command.run_id,
          span_id: typeof command.span_id === "string" ? command.span_id : null,
          kind: "note",
          note: command.note,
          source: parseAnnotationSource(command.source) ?? agentAnnotationSource(agentProvider),
        });
        broadcast("annotation", {
          op: "insert",
          run_id: annotation.run_id,
          span_id: annotation.span_id,
          annotation,
        });
      } catch {}
    }
    broadcast("agent_ui_command", command);
    res.json({ ok: true, command });
  });
  app.get("/api/spans/:id", (req, res) => {
    const row = getSpanMeta(req.params.id) as any;
    if (!row) { res.status(404).json({ error: "Span not found" }); return; }
    const { input_head, output_head, input_chars, output_chars, ...rest } = row;
    res.json({
      ...rest,
      input_chars,
      output_chars,
      input_preview: input_chars > 80 ? input_head.slice(0, 80) + "…" : input_head,
      output_preview: output_chars > 80 ? output_head.slice(0, 80) + "…" : output_head,
    });
  });
  app.get("/api/spans/:id/payload", (req, res) => {
    const target = req.query.target;
    if (target !== "input" && target !== "output") {
      res.status(400).json({ error: "target must be input or output" }); return;
    }
    const payload = getSpanPayloadColumn(req.params.id, target);
    if (payload === null) { res.status(404).json({ error: "Span not found" }); return; }
    const opts: any = { payload };
    if (typeof req.query.jsonpath === "string" && req.query.jsonpath) opts.jsonpath = req.query.jsonpath;
    if (typeof req.query.max_chars === "string") {
      const n = Number(req.query.max_chars);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "max_chars must be a finite number" });
        return;
      }
      opts.maxChars = n;
    }
    if (typeof req.query.format === "string") opts.format = req.query.format;
    if (typeof req.query.range === "string") {
      const [a, b] = req.query.range.split(",").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) opts.range = [a, b];
    }
    try {
      const result = sliceSpanPayload(opts);
      res.json({ span_id: req.params.id, target, ...result });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
  app.get("/api/spans/:id/context", (req, res) => {
    let before: number | undefined;
    let after: number | undefined;
    if (req.query.before !== undefined) {
      const n = Number(req.query.before);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "before must be a finite number" }); return;
      }
      before = n;
    }
    if (req.query.after !== undefined) {
      const n = Number(req.query.after);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "after must be a finite number" }); return;
      }
      after = n;
    }
    const includeParent = req.query.include_parent !== "false";
    const out = getSpanContext(req.params.id, { before, after, includeParent });
    if (!out) { res.status(404).json({ error: "Span not found" }); return; }
    res.json(out);
  });
  app.get("/api/convo/:convoId", (req, res) => res.json(getRunsByConvoId(req.params.convoId)));
  // Regex route so run IDs containing ':', '/', or '.' aren't parsed as Express path-param separators
  app.get(/^\/api\/runs\/detail\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const { run, spans } = getRunWithSpans(id);
    if (!run || spans.length === 0) {
      // Fall back to saved run cache
      const cached = getCachedRun(id);
      if (cached) {
        try { const data = JSON.parse(cached); if (data.run) { res.json(data); return; } } catch {}
      }
      if (!run) { res.status(404).json({ error: "Not found" }); return; }
    }
    const subAgents = detectSubAgents(spans as any);
    res.json({ run, spans, liveEvents: getLiveEvents(id), subAgents });
  });
  app.get("/api/runs/:id/outline", (req, res) => {
    const previewRaw = Number(req.query.payload_preview_chars ?? 80);
    const preview = Number.isFinite(previewRaw) ? previewRaw : 80;
    const out = getRunOutline(req.params.id, preview);
    if (!out.run) { res.status(404).json({ error: "Not found" }); return; }
    res.json(out);
  });
  app.get("/api/runs/:id/spans", (req, res) => {
    const opts: any = { filter: {} };
    for (const k of ["span_type", "status", "name", "name_regex", "model", "parent_span_id", "has_payload_match"]) {
      const v = req.query[k];
      if (typeof v === "string" && v) opts.filter[k] = v;
    }
    for (const k of ["min_duration_ms", "min_tokens"]) {
      const v = req.query[k];
      if (typeof v === "string" && v) opts.filter[k] = Number(v);
    }
    for (const k of ["limit", "offset", "payload_preview_chars"]) {
      const v = req.query[k];
      if (typeof v === "string" && v) opts[k] = Number(v);
    }
    const sort = req.query.sort;
    if (typeof sort === "string") opts.sort = sort;
    res.json(listSpansFiltered(req.params.id, opts));
  });
  app.get("/api/runs/:id/search", (req, res) => {
    const pattern = req.query.pattern;
    if (typeof pattern !== "string" || !pattern) {
      res.status(400).json({ error: "pattern required" }); return;
    }
    const opts: any = { pattern };
    if (req.query.regex === "true") opts.regex = true;
    if (req.query.case_sensitive === "true") opts.case_sensitive = true;
    if (typeof req.query.scope === "string" && req.query.scope) opts.scope = req.query.scope.split(",");
    if (typeof req.query.span_type === "string") opts.span_type = req.query.span_type;
    if (typeof req.query.context_chars === "string") {
      const n = Number(req.query.context_chars);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "context_chars must be a finite number" });
        return;
      }
      opts.context_chars = n;
    }
    if (typeof req.query.max_matches === "string") {
      const n = Number(req.query.max_matches);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "max_matches must be a finite number" });
        return;
      }
      opts.max_matches = n;
    }
    try { res.json(searchRun(req.params.id, opts)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.get("/api/runs/:id/events", (req, res) => {
    const opts: any = {};
    if (typeof req.query.after_id === "string") {
      const n = Number(req.query.after_id);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "after_id must be a finite number" });
        return;
      }
      opts.after_id = n;
    }
    if (typeof req.query.types === "string" && req.query.types) opts.types = req.query.types.split(",");
    if (typeof req.query.limit === "string") {
      const n = Number(req.query.limit);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "limit must be a finite number" });
        return;
      }
      opts.limit = n;
    }
    res.json(tailLiveEvents(req.params.id, opts));
  });
  app.post("/api/clear", (_req, res) => { clearAll(); broadcast("clear", {}); res.json({ ok: true }); });

  app.get("/api/workspace/active", (_req, res) => {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      res.status(404).json({ error: ACTIVE_WORKSPACE_MISSING_MESSAGE });
      return;
    }
    res.json(workspace);
  });

  app.get("/api/workspace/registered", (_req, res) => {
    const active = getActiveWorkspace();
    const byCwd = new Map<string, { cwd: string; agents: string[]; active: boolean }>();
    const add = (cwd: string | null | undefined, agent?: string) => {
      if (!cwd || !path.isAbsolute(cwd)) return;
      try {
        if (!fs.statSync(cwd).isDirectory()) return;
      } catch {
        return;
      }
      const existing = byCwd.get(cwd) ?? { cwd, agents: [], active: active?.cwd === cwd };
      if (agent && !existing.agents.includes(agent)) existing.agents.push(agent);
      existing.active = active?.cwd === cwd;
      byCwd.set(cwd, existing);
    };

    if (active) add(active.cwd);
    try {
      for (const entry of loadInstallRegistry().installs) {
        if (entry.scope === "local") add(entry.cwd, entry.agent);
      }
    } catch {
      // Keep the selector usable even if the optional install registry is unreadable.
    }

    res.json({
      workspaces: [...byCwd.values()].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.cwd.localeCompare(b.cwd);
      }),
    });
  });

  app.post("/api/workspace/active", (req, res) => {
    const cwd = (req.body as Record<string, unknown> | null)?.cwd;
    if (typeof cwd !== "string" || !cwd.trim()) {
      res.status(400).json({ error: "cwd required" });
      return;
    }
    try {
      const workspace = setActiveWorkspace(cwd);
      registerReplayProjectIfPresent(workspace.cwd).catch((err) => {
        console.warn("[workshop] failed to refresh replay project registration:", err);
      });
      try {
        latestClaudeLoadout = getLatestClaudeLoadout(workspace.cwd);
      } catch (err) {
        latestClaudeLoadout = null;
        console.warn("[workshop] failed to load Claude loadout for active workspace:", err);
      }
      broadcast("workspace_changed", workspace);
      res.json(workspace);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/agent/provider", (_req, res) => {
    res.json({ provider: agentProvider });
  });

  app.post("/api/agent/provider", (req, res) => {
    const provider = parseAgentProvider((req.body as Record<string, unknown> | null)?.provider);
    if (!provider) {
      res.status(400).json({ error: "provider must be 'claude' or 'codex'" });
      return;
    }
    agentProvider = setAgentProvider(provider);
    broadcast("agent_provider", { provider: agentProvider });
    const workspace = getActiveWorkspace();
    if (workspace) broadcast("agent_loadout", currentLoadout(workspace));
    res.json({ provider: agentProvider });
  });

  app.get("/api/agent/sessions", (req, res) => {
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;
    const requestedProvider = req.query.provider === undefined
      ? null
      : parseAgentProvider(req.query.provider);
    if (req.query.provider !== undefined && !requestedProvider) {
      res.status(400).json({ error: "provider must be 'claude' or 'codex'" });
      return;
    }
    const targetProvider = requestedProvider ?? agentProvider;
    if (targetProvider === "codex") {
      res.json(listCodexSessions(workspace.cwd));
      return;
    }
    res.json(listClaudeSessions(workspace.cwd));
  });

  app.get("/api/agent/loadout", (_req, res) => {
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;
    res.json(currentLoadout(workspace));
  });

  app.get("/api/agent/sessions/:id", (req, res) => {
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;
    if (agentProvider === "codex") {
      const session = getCodexSession(workspace.cwd, req.params.id);
      if (!session) {
        res.status(404).json({ error: "Codex session not found" });
        return;
      }
      res.json(session);
      return;
    }
    const session = getClaudeSession(workspace.cwd, req.params.id);
    if (!session) {
      res.status(404).json({ error: "Claude session not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/agent/messages", async (req, res) => {
    const { content, session_id, run_id, client_message_id } = req.body ?? {};
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content required" });
      return;
    }
    if (session_id != null && typeof session_id !== "string") {
      res.status(400).json({ error: "session_id must be a string" });
      return;
    }
    const requestProvider = agentProvider;
    if (requestProvider === "claude" && !claudeCliChatEnabled) {
      res.status(409).json({ error: "Claude Code chat is disabled" });
      return;
    }
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;

    let providerSessionId = typeof session_id === "string" && session_id ? session_id : null;
    const clientMessageId = typeof client_message_id === "string" && client_message_id
      ? client_message_id
      : randomUUID();
    let text = "";
    let errorText = "";
    const events: unknown[] = [];
    const broadcastStreamEvent = (event: unknown) => {
      const data = {
        client_message_id: clientMessageId,
        session_id: providerSessionId,
        provider: requestProvider,
        event,
      };
      broadcast("agent_message_stream", data);
      if (requestProvider === "claude") broadcast("claude_message_stream", data);
    };
    try {
      const chatInput = {
        backendUrl: backendUrl(),
        content,
        cwd: workspace.cwd,
        runId: typeof run_id === "string" ? run_id : null,
        resumeSessionId: providerSessionId,
      };
      const result = requestProvider === "codex"
        ? await runCodexCliChat(chatInput, {
          onEvent(event) {
            events.push(event);
            broadcastStreamEvent(event);
          },
          onProviderSession(sessionId) {
            providerSessionId = sessionId;
            broadcastStreamEvent({ type: "provider_session", sessionId });
          },
          onText(nextContent) {
            text = nextContent;
            broadcastStreamEvent({ type: "text", content: nextContent });
          },
          onStatus() {},
          onError(nextContent) {
            errorText = nextContent;
            broadcastStreamEvent({ type: "error", content: nextContent });
          },
        })
        : await runClaudeCliChat(chatInput, {
          onEvent(event) {
            events.push(event);
            rememberClaudeLoadout(event);
            broadcastStreamEvent(event);
          },
          onClaudeSession(sessionId) {
            providerSessionId = sessionId;
            broadcastStreamEvent({ type: "provider_session", sessionId });
          },
          onText(nextContent) {
            text = nextContent;
            broadcastStreamEvent({ type: "text", content: nextContent });
          },
          onStatus() {},
          onError(nextContent) {
            errorText = nextContent;
            broadcastStreamEvent({ type: "error", content: nextContent });
          },
        });
      if (result.code !== 0 || errorText) {
        res.status(502).json({
          error: errorText || result.stderr || `${agentProviderLabel(requestProvider)} exited with code ${result.code ?? "unknown"}`,
          client_message_id: clientMessageId,
          session_id: providerSessionId,
          events,
        });
        return;
      }
      res.json({
        client_message_id: clientMessageId,
        session_id: providerSessionId,
        text,
        events,
        session: providerSessionId
          ? requestProvider === "claude"
            ? getClaudeSession(workspace.cwd, providerSessionId)
            : getCodexSession(workspace.cwd, providerSessionId)
          : null,
      });
    } catch (err) {
      res.status(500).json({
        error: (err as Error).message || `${agentProviderLabel(requestProvider)} chat failed`,
        client_message_id: clientMessageId,
        session_id: providerSessionId,
        events,
      });
    }
  });

  app.get("/api/claude/sessions", (_req, res) => {
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;
    res.json(listClaudeSessions(workspace.cwd));
  });

  app.get("/api/claude/loadout", (_req, res) => {
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;
    if (!latestClaudeLoadout) {
      latestClaudeLoadout = getLatestClaudeLoadout(workspace.cwd);
    }
    res.json(latestClaudeLoadout ?? { tools: [], mcps: [], skills: [], plugins: [], slash_commands: [] });
  });

  app.get("/api/claude/sessions/:id", (req, res) => {
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;
    const session = getClaudeSession(workspace.cwd, req.params.id);
    if (!session) {
      res.status(404).json({ error: "Claude session not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/claude/ask-user-question/hook", async (req, res) => {
    const hookInput = parseAskUserQuestionHookInput(req.body);
    if (!hookInput) {
      res.status(400).json({ error: "AskUserQuestion tool_input.questions required" });
      return;
    }

    const answers = await askUserQuestions.ask(hookInput);
    res.json(answers
      ? askUserQuestionAllow(hookInput.toolInput, answers)
      : askUserQuestionDeny("Workshop closed before the question was answered."));
  });

  app.post("/api/claude/ask-user-question/:id/answer", (req, res) => {
    const answers = parseAnswerMap((req.body as Record<string, unknown> | null)?.answers);
    if (!answers) {
      res.status(400).json({ error: "answers must be a non-empty string map" });
      return;
    }
    if (!askUserQuestions.answer(req.params.id, answers)) {
      res.status(404).json({ error: "pending question not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/claude/messages", async (req, res) => {
    const { content, session_id, run_id, client_message_id } = req.body ?? {};
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content required" });
      return;
    }
    if (session_id != null && typeof session_id !== "string") {
      res.status(400).json({ error: "session_id must be a string" });
      return;
    }
    if (!claudeCliChatEnabled) {
      res.status(409).json({ error: "Claude Code chat is disabled" });
      return;
    }
    const workspace = activeWorkspaceOrError(res);
    if (!workspace) return;

    let claudeSessionId = typeof session_id === "string" && session_id ? session_id : null;
    const clientMessageId = typeof client_message_id === "string" && client_message_id
      ? client_message_id
      : randomUUID();
    let text = "";
    let errorText = "";
    const events: unknown[] = [];
    const broadcastStreamEvent = (event: unknown) => {
      broadcast("claude_message_stream", {
        client_message_id: clientMessageId,
        session_id: claudeSessionId,
        event,
      });
    };
    try {
      const result = await runClaudeCliChat(
        {
          backendUrl: backendUrl(),
          content,
          cwd: workspace.cwd,
          runId: typeof run_id === "string" ? run_id : null,
          resumeSessionId: claudeSessionId,
        },
        {
          onEvent(event) {
            events.push(event);
            rememberClaudeLoadout(event);
            broadcastStreamEvent(event);
          },
          onClaudeSession(sessionId) {
            claudeSessionId = sessionId;
            broadcastStreamEvent({ type: "provider_session", sessionId });
          },
          onText(content) {
            text = content;
            broadcastStreamEvent({ type: "text", content });
          },
          onStatus() {},
          onError(content) {
            errorText = content;
            broadcastStreamEvent({ type: "error", content });
          },
        },
      );
      if (result.code !== 0 || errorText) {
        res.status(502).json({
          error: errorText || result.stderr || `Claude Code exited with code ${result.code ?? "unknown"}`,
          client_message_id: clientMessageId,
          session_id: claudeSessionId,
          events,
        });
        return;
      }
      res.json({
        client_message_id: clientMessageId,
        session_id: claudeSessionId,
        text,
        events,
        session: claudeSessionId ? getClaudeSession(workspace.cwd, claudeSessionId) : null,
      });
    } catch (err) {
      res.status(500).json({
        error: (err as Error).message || "Claude Code chat failed",
        client_message_id: clientMessageId,
        session_id: claudeSessionId,
        events,
      });
    }
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      agent_provider: agentProvider,
      agent: {
        provider: agentProvider,
        mode: agentProvider === "codex" ? "codex_exec_stream" : "cli_stream",
        state: agentProvider === "codex" || claudeCliChatEnabled ? "green" : "gray",
      },
      claude_code: {
        mode: "cli_stream",
        state: claudeCliChatEnabled ? "green" : "gray",
      },
      codex: {
        mode: "codex_exec_stream",
        state: "green",
      },
    });
  });

  app.get("/api/models/anthropic", async (req, res) => {
    if (anthropicModelsCache && anthropicModelsCache.expiresAt > Date.now()) {
      res.json({ models: anthropicModelsCache.models, cached: true });
      return;
    }

    const clientKey = req.header("x-rd-api-key");
    const apiKey = clientKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(400).json({ error: "No Anthropic API key. Add one in Settings." });
      return;
    }

    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!resp.ok) {
        const err = await resp.text();
        if (anthropicModelsCache?.models?.length) {
          res.json({ models: anthropicModelsCache.models, cached: true, stale: true });
          return;
        }
        res.status(resp.status).json({ error: err || `Anthropic models request failed (${resp.status})` });
        return;
      }

      const payload = await resp.json().catch(() => ({}));
      const rows = Array.isArray((payload as any)?.data)
        ? (payload as any).data
        : Array.isArray((payload as any)?.models)
          ? (payload as any).models
          : [];
      const models = rows
        .map((m: any) => (typeof m?.id === "string" ? m.id : null))
        .filter((id: string | null): id is string => !!id)
        .sort((a: string, b: string) => a.localeCompare(b));

      if (models.length === 0) {
        if (anthropicModelsCache?.models?.length) {
          res.json({ models: anthropicModelsCache.models, cached: true, stale: true });
          return;
        }
        res.status(502).json({ error: "Anthropic models response was empty." });
        return;
      }

      anthropicModelsCache = {
        expiresAt: Date.now() + ANTHROPIC_MODELS_CACHE_TTL_MS,
        models,
      };
      res.json({ models, cached: false });
    } catch (err: any) {
      if (anthropicModelsCache?.models?.length) {
        res.json({ models: anthropicModelsCache.models, cached: true, stale: true });
        return;
      }
      res.status(500).json({ error: err?.message ?? "Failed to fetch Anthropic models." });
    }
  });

  app.get("/api/annotations", (req, res) => {
    const runId = req.query.run_id;
    if (typeof runId !== "string" || !runId) {
      res.status(400).json({ error: "run_id required" });
      return;
    }
    res.json(getAnnotationsByRun(runId));
  });

  app.post("/api/annotations", (req, res) => {
    const body = (req.body ?? {}) as {
      run_id?: unknown;
      span_id?: unknown;
      kind?: unknown;
      note?: unknown;
      source?: unknown;
    };
    if (typeof body.run_id !== "string" || !body.run_id) {
      res.status(400).json({ error: "run_id required" });
      return;
    }
    if (typeof body.kind !== "string") {
      res.status(400).json({ error: "kind required" });
      return;
    }
    if (typeof body.source !== "string") {
      res.status(400).json({ error: "source required" });
      return;
    }
    try {
      const annotation = createAnnotation({
        run_id: body.run_id,
        span_id: typeof body.span_id === "string" ? body.span_id : null,
        kind: body.kind as AnnotationKind,
        note: typeof body.note === "string" ? body.note : null,
        source: body.source as AnnotationSource,
      });
      broadcast("annotation", {
        op: "insert",
        run_id: annotation.run_id,
        span_id: annotation.span_id,
        annotation,
      });
      res.status(201).json(annotation);
    } catch (err) {
      if (err instanceof InvalidAnnotationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete("/api/annotations/:id", (req, res) => {
    try {
      const removed = deleteAnnotation(req.params.id);
      broadcast("annotation", {
        op: "delete",
        run_id: removed.run_id,
        span_id: removed.span_id,
        annotation: removed,
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof AnnotationNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get("/api/runs/:id/steering", (req, res) => {
    const events = listSteeringEventsForRun(req.params.id);
    const observerRunsByMetadata = getObserverRunsForObservedRun(req.params.id);
    const observerRunIds = [
      ...new Set([
        ...observerRunsByMetadata.map((run: any) => run.id).filter(Boolean),
        ...listObserverRunsForRun(req.params.id),
      ]),
    ];
    res.json({
      events,
      observerRunIds,
      observerRuns: observerRunIds
        .map((id) => observerRunsByMetadata.find((run: any) => run.id === id) ?? getRunById(id))
        .filter(Boolean),
    });
  });

  app.post("/api/steering/events", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const observedRunId = bodyString(body, "observed_run_id", "observedRunId");
    const observerRunId = bodyString(body, "observer_run_id", "observerRunId");
    const targetSpanId = bodyString(body, "target_span_id", "targetSpanId");
    const targetSubagentSpanId = bodyString(body, "target_subagent_span_id", "targetSubagentSpanId");
    const beforePrompt = bodyString(body, "before_prompt", "beforePrompt");
    const afterPrompt = bodyString(body, "after_prompt", "afterPrompt");
    const action = bodyString(body, "action") as SteeringAction | undefined;
    const status = bodyString(body, "status") as SteeringStatus | undefined;
    const confidence = typeof body.confidence === "number" ? body.confidence : undefined;

    if (!observedRunId) {
      res.status(400).json({ error: "observed_run_id required" });
      return;
    }
    if (!action) {
      res.status(400).json({ error: "action required" });
      return;
    }

    try {
      const event = createSteeringEvent({
        observed_run_id: observedRunId,
        observer_run_id: observerRunId,
        target_span_id: targetSpanId,
        target_subagent_span_id: targetSubagentSpanId,
        action,
        status,
        message: bodyString(body, "message"),
        before_prompt: beforePrompt,
        after_prompt: afterPrompt,
        reason: bodyString(body, "reason"),
        source: bodyString(body, "source") ?? "external-observer",
        confidence,
      });
      broadcast("steering", {
        op: "insert",
        observed_run_id: event.observed_run_id,
        observer_run_id: event.observer_run_id,
        target_span_id: event.target_span_id,
        target_subagent_span_id: event.target_subagent_span_id,
        event,
      });
      res.status(201).json({ ok: true, mocked: event.status === "mock_applied", event });
    } catch (err) {
      if (err instanceof InvalidSteeringEventError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete("/api/runs/:id", (req, res) => {
    try {
      deleteRun(req.params.id);
      broadcast("spans", { runIds: [req.params.id] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Saved run cache — persists across clears
  app.put(/^\/api\/saved-runs\/cache\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    cacheSavedRun(id, JSON.stringify(req.body));
    res.json({ ok: true });
  });
  app.get(/^\/api\/saved-runs\/cache\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const data = getCachedRun(id);
    if (!data) { res.status(404).json({ error: "Not cached" }); return; }
    res.json(JSON.parse(data));
  });
  app.delete(/^\/api\/saved-runs\/cache\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    deleteCachedRun(id);
    res.json({ ok: true });
  });

  // Saved events index + folders — server-side store so saves are visible
  // across browsers (Cursor, Chrome, …) hitting the same workshop instance.
  app.get("/api/saved-runs", (_req, res) => {
    res.json({ events: listSavedEvents(), folders: listSavedFolders() });
  });

  app.get("/api/saved-runs/folders", (_req, res) => {
    res.json({ folders: listSavedFolders() });
  });

  app.post("/api/saved-runs/folders", (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const color = typeof req.body?.color === "string" ? req.body.color : undefined;
    if (!name) { res.status(400).json({ error: "name required" }); return; }
    res.json({ folder: ensureSavedFolder(name, color) });
  });

  app.delete(/^\/api\/saved-runs\/folders\/(.+)$/, (req, res) => {
    const name = decodeURIComponent((req.params as unknown as string[])[0]);
    deleteSavedFolder(name);
    res.json({ ok: true });
  });

  app.get(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const event = getSavedEvent(id);
    if (!event) { res.status(404).json({ error: "Not saved" }); return; }
    res.json({ event });
  });

  app.put(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const body = req.body ?? {};
    if (typeof body !== "object") { res.status(400).json({ error: "body required" }); return; }
    if (typeof body.event_name !== "string" || !body.event_name) {
      res.status(400).json({ error: "event_name required" }); return;
    }
    if (typeof body.timestamp !== "string" || !body.timestamp) {
      res.status(400).json({ error: "timestamp required" }); return;
    }
    const event: SavedEventRow = {
      id,
      event_name: body.event_name,
      user_id: body.user_id ?? null,
      convo_id: body.convo_id ?? null,
      timestamp: body.timestamp,
      user_input: body.user_input ?? null,
      assistant_output: body.assistant_output ?? null,
      signals: Array.isArray(body.signals) ? body.signals : null,
      properties: body.properties && typeof body.properties === "object" ? body.properties : null,
      saved_at: typeof body.saved_at === "number" ? body.saved_at : Date.now(),
      summary: body.summary ?? null,
      source: body.source === "cloud" || body.source === "local" ? body.source : null,
      folder: typeof body.folder === "string" && body.folder ? body.folder : null,
    };
    upsertSavedEvent(event);
    if (event.folder) ensureSavedFolder(event.folder);
    res.json({ event });
  });

  app.patch(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const body = req.body ?? {};
    const patch: Partial<Omit<SavedEventRow, "id">> = {};
    if (Object.prototype.hasOwnProperty.call(body, "folder")) {
      patch.folder = typeof body.folder === "string" && body.folder ? body.folder : null;
    }
    if (typeof body.summary === "string") patch.summary = body.summary;
    if (typeof body.user_input === "string") patch.user_input = body.user_input;
    if (typeof body.assistant_output === "string") patch.assistant_output = body.assistant_output;
    if (typeof body.saved_at === "number") patch.saved_at = body.saved_at;
    if (body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)) {
      patch.properties = body.properties;
    }
    const event = patchSavedEvent(id, patch);
    if (!event) { res.status(404).json({ error: "Not saved" }); return; }
    if (event.folder) ensureSavedFolder(event.folder);
    res.json({ event });
  });

  app.delete(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    deleteSavedEvent(id);
    deleteCachedRun(id);
    res.json({ ok: true });
  });

  // Import a cloud run + spans into the local DB so replay can use them
  app.post("/api/import-run", (req, res) => {
    const { run, spans } = req.body;
    if (!run?.id || !Array.isArray(spans)) {
      res.status(400).json({ error: "run and spans[] are required" });
      return;
    }
    upsertRun({
      id: run.id,
      name: run.name ?? null,
      event_name: run.event_name ?? null,
      user_id: run.user_id ?? null,
      convo_id: run.convo_id ?? null,
      started_at: run.started_at ?? Date.now(),
      last_updated_at: run.last_updated_at ?? Date.now(),
      metadata: run.metadata ?? null,
    });
    for (const s of spans) {
      insertSpan({
        id: s.id, run_id: run.id, parent_span_id: s.parent_span_id ?? undefined,
        name: s.name, span_type: s.span_type ?? undefined, status: s.status ?? "UNSET",
        input_payload: s.input_payload ?? undefined, output_payload: s.output_payload ?? undefined,
        start_time_ms: s.start_time_ms, end_time_ms: s.end_time_ms, duration_ms: s.duration_ms,
        model: s.model ?? undefined, provider: s.provider ?? undefined,
        input_tokens: s.input_tokens ?? undefined, output_tokens: s.output_tokens ?? undefined,
        attributes: s.attributes ?? undefined,
      });
    }
    broadcast("spans", { runIds: [run.id] });
    res.json({ ok: true, runId: run.id });
  });

  // Summarize an event using Haiku (server-side to avoid CORS)
  app.post("/api/summarize", async (req, res) => {
    const { content, apiKey } = req.body;
    if (!content) { res.status(400).json({ error: "content is required" }); return; }
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) { res.status(400).json({ error: "No Anthropic API key" }); return; }
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          system: "Summarize this AI agent interaction in 1-2 sentences. Focus on what user asked and what happened (tools used, outcome). Be specific and brief. Avoid unnecessary articles like 'the', 'a', 'an' — write in a terse, telegraphic style.",
          messages: [{ role: "user", content }],
        }),
      });
      if (!r.ok) { const b = await r.json().catch(() => null); res.status(r.status).json({ error: b?.error?.message ?? `Anthropic error ${r.status}` }); return; }
      const data = await r.json();
      const text = data.content?.find((b: any) => b.type === "text")?.text?.trim() ?? "";
      res.json({ summary: text });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Summarization failed" });
    }
  });

  // Agent config API
  app.get("/api/agents", async (_req, res) => {
    const discovered = await discoverReplayAgents();
    res.json({ ...loadAgentsConfig(), ...discovered });
  });

  app.put("/api/agents", (req, res) => {
    try {
      const agents = saveAgentsConfig(req.body);
      // Notify any open Workshop UIs that the registry changed so the
      // "Local Agent" replay button un-greys without a page reload.
      broadcast("agents_updated", { agents });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/agents/refresh", async (_req, res) => {
    await discoverReplayAgents();
    const agents = loadAgentsConfig();
    broadcast("agents_updated", { agents });
    res.json({ ok: true, agents });
  });

  // Proxy health check for agent endpoints (avoids CORS issues from browser)
  async function probeAgentHealth(): Promise<Record<string, "online" | "offline">> {
    const discovered = await discoverReplayAgents();
    const agents = { ...loadAgentsConfig(), ...discovered };
    const results: Record<string, "online" | "offline"> = {};
    await Promise.all(
      Object.entries(agents).map(async ([name, config]) => {
        // discoverReplayAgents only returns agents that just responded healthy.
        if (discovered[name]) { results[name] = "online"; return; }
        if (!config.url) { results[name] = "offline"; return; }
        const base = config.url.replace(/\/replay\/?$/, "");
        try {
          const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
          results[name] = resp.ok ? "online" : "offline";
        } catch {
          results[name] = "offline";
        }
      })
    );
    return results;
  }

  app.get("/api/agents/health", async (_req, res) => {
    res.json(await probeAgentHealth());
  });

  app.post("/api/agents/ask", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      res.status(400).json({ status: "invalid_request", error: "question is required" });
      return;
    }

    const requestedRunId = typeof body.run_id === "string"
      ? body.run_id
      : typeof body.runId === "string"
        ? body.runId
        : null;
    const runId = requestedRunId ? resolveRunId(requestedRunId) : getMostRecentlyTouchedRun()?.id;
    if (!runId) {
      res.status(404).json({ status: "missing_run", error: "No Workshop trace is selected or available." });
      return;
    }

    const { run, spans } = getRunWithSpans(runId);
    if (!run) {
      res.status(404).json({ status: "missing_run", run_id: runId, error: "Run not found." });
      return;
    }

    const workspace = getActiveWorkspace();
    const continuation = extractAgentAskContinuation(spans);
    if (!continuation) {
      res.json({
        status: "missing_context",
        run_id: runId,
        cwd: workspace?.cwd ?? null,
        message: "This run does not include an LLM input payload that Workshop can continue.",
      });
      return;
    }

    const requestedModel = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : null;
    const model = requestedModel ?? continuation.model ?? "claude-sonnet-4-20250514";
    const provider = detectProvider(model, continuation.provider);
    const env = providerEnvForProvider(provider);
    const clientOpenaiKey = typeof body.openaiKey === "string" ? body.openaiKey : null;
    const clientAnthropicKey = typeof body.apiKey === "string" ? body.apiKey : null;
    const apiKey = provider === "openai"
      ? (clientOpenaiKey || process.env.OPENAI_API_KEY)
      : (clientAnthropicKey || process.env.ANTHROPIC_API_KEY);

    if (!apiKey) {
      res.json({
        status: "missing_provider_key",
        run_id: runId,
        provider,
        env_var: env.envVar,
        cwd: workspace?.cwd ?? null,
        message: `Add ${env.envVar}=... to ${workspace?.cwd ? `${workspace.cwd}/.env` : "the active project .env"} and restart Workshop.`,
      });
      return;
    }

    const framedQuestion = buildAgentAskQuestion({ question, run, spans });
    const contextMessages = [
      ...continuation.messages.map(cleanProviderMessage),
      cleanProviderMessage({ role: "user", content: framedQuestion }),
    ];

    const requestBody: Record<string, any> = {
      model,
      stream: false,
    };
    if (provider === "openai") {
      requestBody.messages = [
        { role: "system", content: continuation.systemPrompt },
        ...contextMessages,
      ];
      requestBody.max_completion_tokens = 4096;
    } else {
      requestBody.system = continuation.systemPrompt;
      requestBody.messages = contextMessages;
      requestBody.max_tokens = 4096;
    }

    const apiHeaders = getProviderHeaders(provider, apiKey);
    Object.assign(apiHeaders, continuation.providerHeaders);
    applyProviderOptions(continuation.providerOptions, requestBody, apiHeaders);
    if (continuation.thinkingConfig) requestBody.thinking = continuation.thinkingConfig;

    try {
      const agentRes = await fetch(getProviderBaseURL(provider, null), {
        method: "POST",
        headers: apiHeaders,
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify(requestBody),
      });

      const responseText = await agentRes.text();
      const responseBody = parseJsonObject(responseText);
      if (!agentRes.ok) {
        res.json({
          status: "provider_error",
          run_id: runId,
          provider,
          model,
          message: answerFromProviderResponse(responseBody, responseText) || `Provider returned ${agentRes.status}.`,
        });
        return;
      }

      res.json({
        status: "answered",
        run_id: runId,
        provider,
        model,
        answer: answerFromProviderResponse(responseBody, responseText),
      });
    } catch (err) {
      res.json({
        status: "provider_error",
        run_id: runId,
        provider,
        model,
        message: (err as Error).message,
      });
    }
  });

  // Resolve agent context from a trace — returns the key/value pairs that would be sent to the agent
  app.post("/api/replay/context", (req, res) => {
    const { runId, eventName } = req.body;
    if (!runId) { res.status(400).json({ error: "runId is required" }); return; }
    const agents = loadAgentsConfig();
    const name = (eventName ?? "").replace(/^replay:/, "");
    const agentConfig = agents[name];
    const mapping = agentConfig?.prefillFromTrace ?? agentConfig?.contextFromTrace;
    if (!mapping) { res.json({ context: {}, mapping: {} }); return; }
    const { spans } = getRunWithSpans(runId);
    const context = extractContextFromTrace(spans, mapping);
    res.json({ context, mapping });
  });

  // Replay endpoint
  app.post("/api/replay", async (req, res) => {
    const { runId, userMessage, model, systemPrompt, apiKey, openaiKey, maxIterations, contextOverrides } = req.body;
    if (!runId) { res.status(400).json({ error: "runId is required" }); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      await runReplay(
        { sourceRunId: runId, mode: "local", userMessage, model, systemPrompt, apiKey, openaiKey, maxIterations, contextOverrides },
        res,
        broadcast,
      );
    } catch (err) {
      console.error("[workshop] Replay error:", err);
      res.write(`data: ${JSON.stringify({ type: "error", code: "replay_internal_error", message: String(err) })}\n\n`);
      res.end();
    }
  });

  // Serve built Vite UI (skip if debugger UI dev server is running separately)
  if (!process.env.DEBUGGER_DEV) {
    const builtAppDir = await resolveBuiltAppDir();
    app.use(express.static(builtAppDir));
    app.get("*", (_req, res) => res.sendFile(path.join(builtAppDir, "index.html")));
  }

  return { app, server, port };
}

function parseJsonObject(text: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

type AgentAskContinuation = {
  systemPrompt: string;
  messages: any[];
  model: string | null;
  provider: string | null;
  thinkingConfig: any;
  providerOptions: any;
  providerHeaders: Record<string, string>;
};

function buildAgentAskQuestion(input: { question: string; run: any; spans: any[] }): string {
  const traceContext = buildAgentAskTraceContext(input.run, input.spans);
  return [
    "You are being asked a follow-up question after one of your completed agent runs.",
    "Raindrop Workshop captured the trace below. Use it as context to reflect on what happened in your run.",
    "If the user asks why you called a tool, what a tool did, or which tool was most useful/fun, answer from the trace evidence instead of saying you lack context.",
    "For subjective wording like \"fun\", interpret it as the tool that seemed most satisfying, useful, or high-leverage in the run.",
    "",
    "TRACE CONTEXT:",
    traceContext,
    "",
    "USER QUESTION:",
    input.question,
  ].join("\n");
}

function buildAgentAskTraceContext(run: any, spans: any[]): string {
  const lines: string[] = [
    `run_id: ${run?.id ?? "unknown"}`,
    `event_name: ${run?.event_name ?? run?.name ?? "unknown"}`,
    `span_count: ${spans.length}`,
  ];
  const toolSpans = spans.filter((span) => span?.span_type === "TOOL_CALL").slice(0, 20);
  const llmSpans = spans.filter((span) => span?.span_type?.includes("LLM")).slice(0, 10);
  if (toolSpans.length > 0) {
    lines.push("", "tools:");
    for (const span of toolSpans) {
      lines.push(`- ${span.name ?? span.id ?? "tool"} (${span.status ?? "unknown"}, ${span.duration_ms ?? 0}ms)`);
      const inputPreview = previewText(span.input_payload, 140);
      const outputPreview = previewText(span.output_payload, 180);
      if (inputPreview) lines.push(`  input: ${inputPreview}`);
      if (outputPreview) lines.push(`  output: ${outputPreview}`);
    }
  }
  if (llmSpans.length > 0) {
    lines.push("", "llm_spans:");
    for (const span of llmSpans) {
      lines.push(`- ${span.name ?? span.id ?? "llm"} (${span.model ?? "unknown model"})`);
      const outputPreview = previewText(span.output_payload, 180);
      if (outputPreview) lines.push(`  output: ${outputPreview}`);
    }
  }
  return lines.join("\n").slice(0, 12_000);
}

function extractAgentAskContinuation(spans: any[]): AgentAskContinuation | null {
  const llmSpans = spans.filter((s) => s?.span_type?.includes("LLM") && s.input_payload);
  let selected = llmSpans[0];
  for (const span of llmSpans.slice(1)) {
    if ((span.input_payload?.length ?? 0) > (selected.input_payload?.length ?? 0)) {
      selected = span;
    }
  }

  if (!selected?.input_payload) return null;

  let systemPrompt = "You are a helpful assistant.";
  let messages: any[] = [];
  try {
    const parsed = JSON.parse(selected.input_payload);
    if (Array.isArray(parsed)) {
      const systemMessages: string[] = [];
      for (const message of parsed) {
        if (message?.role === "system") {
          systemMessages.push(contentToText(message.content));
        } else {
          messages.push(message);
        }
      }
      if (systemMessages.length > 0) systemPrompt = systemMessages.join("\n\n");
    } else if (parsed && typeof parsed === "object") {
      if (parsed.system) systemPrompt = systemToText(parsed.system);
      if (Array.isArray(parsed.messages)) messages = parsed.messages;
      if (parsed.prompt && !Array.isArray(parsed.messages)) {
        messages = [{ role: "user", content: contentToText(parsed.prompt) }];
      }
    }
  } catch {
    return null;
  }

  const finalOutput = llmSpans[llmSpans.length - 1]?.output_payload;
  const lastMessage = messages[messages.length - 1];
  if (finalOutput && lastMessage?.role !== "assistant") {
    messages.push({ role: "assistant", content: finalOutput });
  }

  const attrs = parseJsonObject(llmSpans[llmSpans.length - 1]?.attributes ?? "") ?? {};
  const thinkingConfig = parseJsonObjectValue(attrs["ai.request.thinking"]);
  const providerOptions = parseJsonObjectValue(attrs["ai.request.providerOptions"]);
  const providerHeaders = parseProviderHeaders(attrs["ai.provider.headers"]);

  return {
    systemPrompt,
    messages,
    model: selected.model ?? null,
    provider: selected.provider ?? null,
    thinkingConfig,
    providerOptions,
    providerHeaders,
  };
}

function previewText(value: unknown, limit: number): string | null {
  if (value == null) return null;
  const text = contentToText(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function contentToText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function systemToText(system: any): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((part) => typeof part === "string" ? part : part?.content ?? JSON.stringify(part)).join("\n\n");
  }
  return system?.content ? contentToText(system.content) : JSON.stringify(system);
}

function parseJsonObjectValue(value: unknown): Record<string, any> | undefined {
  if (typeof value !== "string") return undefined;
  return parseJsonObject(value) ?? undefined;
}

function parseProviderHeaders(value: unknown): Record<string, string> {
  const parsed = parseJsonObjectValue(value);
  if (!parsed) return {};
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue === "string") headers[key] = headerValue;
  }
  return headers;
}

const ALLOWED_PROVIDER_MESSAGE_KEYS = new Set(["role", "content"]);
const ALLOWED_PROVIDER_CONTENT_KEYS: Record<string, Set<string>> = {
  text: new Set(["type", "text"]),
  tool_use: new Set(["type", "id", "name", "input"]),
  tool_result: new Set(["type", "tool_use_id", "content", "is_error"]),
  thinking: new Set(["type", "thinking", "signature"]),
};

function cleanProviderMessage(message: any): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const key of Object.keys(message ?? {})) {
    if (ALLOWED_PROVIDER_MESSAGE_KEYS.has(key)) clean[key] = message[key];
  }
  if (clean.role === "tool") clean.role = "user";
  if (Array.isArray(clean.content)) {
    clean.content = clean.content.map((contentPart: any) => {
      if (typeof contentPart === "string") return contentPart;
      const allowed = ALLOWED_PROVIDER_CONTENT_KEYS[contentPart?.type];
      if (!allowed) return { type: "text", text: JSON.stringify(contentPart) };
      const filteredPart: Record<string, any> = {};
      for (const key of Object.keys(contentPart)) {
        if (allowed.has(key)) filteredPart[key] = contentPart[key];
      }
      return filteredPart;
    });
  }
  return clean;
}

function providerEnvForProvider(provider: string): { envVar: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" } {
  return provider === "openai" ? { envVar: "OPENAI_API_KEY" } : { envVar: "ANTHROPIC_API_KEY" };
}

function answerFromProviderResponse(body: Record<string, any> | null, text: string): string {
  if (!body) return text.trim();
  const openAiContent = body.choices?.[0]?.message?.content;
  if (typeof openAiContent === "string") return openAiContent.trim();
  if (Array.isArray(body.content)) {
    const joined = body.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (joined.trim()) return joined.trim();
  }
  for (const key of ["answer", "response", "message", "summary", "error"]) {
    if (typeof body[key] === "string" && body[key].trim()) return body[key].trim();
  }
  return JSON.stringify(body, null, 2);
}

function canonicalizeAgentUiCommand(command: Record<string, unknown>): Record<string, unknown> | null {
  if (command.type === "open_filter") return command;
  if (
    command.type !== "navigate_to_run" &&
    command.type !== "compose_annotation"
  ) {
    return null;
  }
  if (typeof command.run_id !== "string" || !command.run_id) return null;
  const runId = resolveRunId(command.run_id);
  if (!runId) return null;
  return { ...command, run_id: runId };
}

function resolveRunId(input: string): string | null {
  if (getRunById(input)) return input;
  if (input.length < 4) return null;
  const matches = (getRuns() as Array<{ id: string }>).filter((run) => run.id.startsWith(input));
  if (matches.length !== 1) return null;
  return matches[0].id;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

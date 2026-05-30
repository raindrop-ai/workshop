import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Express } from "express";
import { loadWorkspaceEnv } from "../loadEnv.ts";

loadWorkspaceEnv(import.meta.url);

const DEFAULT_PORT = Number(process.env.PORT ?? 3031);
const DEFAULT_MODEL = process.env.OPENCODE_OBSERVER_MODEL ?? "openai/gpt-5.5-pro";
const WORKSHOP_BASE = process.env.RAINDROP_WORKSHOP_URL ?? "http://localhost:5899";
const OPENCODE_CONTROL_URL = process.env.OPENCODE_CONTROL_URL ?? "http://localhost:3032";
const WATCH_EVENT_NAME = process.env.OPENCODE_OBSERVER_WATCH_EVENT ?? "opencode_session";
const WATCH_POLL_MS = Number(process.env.OPENCODE_OBSERVER_POLL_MS ?? 2000);
const ACTIVE_OBSERVE_MS = Number(process.env.OPENCODE_OBSERVER_ACTIVE_MS ?? 10000);
const WORKSHOP_DB_PATH =
  process.env.RAINDROP_WORKSHOP_DB_PATH ??
  path.join(homedir(), ".raindrop", "raindrop_workshop.db");

const PLUGIN_PACKAGE = "@raindrop-ai/opencode-plugin";
const PLUGIN_LINK_TARGET = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "node_modules",
  PLUGIN_PACKAGE,
);

const OBSERVER_SYSTEM_PROMPT = `You are Raindrop Observer, an LLM-as-judge supervising live coding-agent subagents.

Your job is to inspect Raindrop Workshop traces in SQLite, detect whether subagents are stuck, repeating low-value work, reading the wrong path, or failing tools, and then write a concise steering event back to Workshop.

Principles:
- Be evidence-driven. Use SQLite queries against the local Workshop database before judging.
- Prefer small nudges over broad restarts.
- Do not invent facts from missing payloads.
- Do not post steering events for healthy progress, routine turns, or "continue" decisions.
- A steering event is corrective: only post when the active agent or subagent appears to be drifting from the main task context, stuck, repeating low-value work, reading the wrong path, or failing tools.
- Base wrong-direction judgments on the main user/context prompt plus the current subagent prompt/tool behavior.
- Never copy example text into a steering event unless the exact evidence appears in the trace you queried.
- If evidence is thin or the run is healthy, do not post to /api/steering/events. The observer trace itself is enough.
- If the repeated-tool query returns no rows, do not claim repeated tool calls.
- If the error query returns no rows, do not claim failed reads or tool errors.
- Never send placeholder IDs such as "<RUN_ID>" or "<TASK_SPAN_ID>" in writeback.
- A nudge should be actionable in one sentence.
- A system prompt update should include before_prompt and after_prompt when you can infer the current task prompt.
- Use "restart" only when the subagent is clearly on the wrong path or cannot recover.
- Use "stop" only when continuing is wasteful or harmful.

SQLite access:
- Database path: ${WORKSHOP_DB_PATH}
- Use sqlite3 from the shell. Always quote the DB path.
- Main tables:
  - runs(id,event_id,name,event_name,user_id,convo_id,started_at,last_updated_at,metadata)
  - spans(id,run_id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes)
  - live_events(id,trace_id,span_id,type,content,timestamp,metadata)
  - steering_events(id,observed_run_id,observer_run_id,target_span_id,target_subagent_span_id,action,status,message,before_prompt,after_prompt,reason,source,confidence,created_at)

Useful queries:
\`\`\`bash
sqlite3 -json "${WORKSHOP_DB_PATH}" "select id,event_name,name,started_at,last_updated_at from runs order by last_updated_at desc limit 10;"
sqlite3 -json "${WORKSHOP_DB_PATH}" "select id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,duration_ms from spans where run_id='<RUN_ID>' order by start_time_ms;"
sqlite3 -json "${WORKSHOP_DB_PATH}" "select parent_span_id,name,status,count(*) as n from spans where run_id='<RUN_ID>' and span_type='TOOL_CALL' group by parent_span_id,name,status order by n desc;"
sqlite3 -json "${WORKSHOP_DB_PATH}" "select id,parent_span_id,name,status,input_payload,output_payload from spans where run_id='<RUN_ID>' and status='ERROR';"
sqlite3 -json "${WORKSHOP_DB_PATH}" "select id,event_name,user_id,metadata,last_updated_at from runs where user_id='opencode-observer' or metadata like '%\\"observedRunId\\":\\"<RUN_ID>\\"%' order by last_updated_at desc limit 3;"
\`\`\`

Subagent detection:
- A subagent is usually a TOOL_CALL span named "task".
- Its input_payload JSON often contains description, prompt, subagent_type.
- Descendant spans show the subagent's LLM calls and tools.
- Repeated glob/read calls with "No files found" or path errors are evidence for a nudge.

Writeback:
- Example only, do not copy these values. If a real OpenCode control endpoint is available and you have a real task span id, send the nudge there first:
\`\`\`bash
curl -sS -X POST "${OPENCODE_CONTROL_URL}/nudge" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "runId": "<RUN_ID>",
    "targetSubagentSpanId": "<TASK_SPAN_ID>",
    "message": "Verify the repo root before continuing; repeated glob calls are returning no source files.",
    "afterPrompt": "First verify the repo root and list top-level files. If no source files exist, stop searching and report missing project structure."
  }'
\`\`\`
- Then post the same steering decision to Workshop so the UI can show it. Only do this for corrective steering:
\`\`\`bash
curl -sS -X POST "${WORKSHOP_BASE}/api/steering/events" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "observedRunId": "<RUN_ID>",
    "observerRunId": "<YOUR_OBSERVER_TRACE_RUN_ID_IF_FOUND>",
    "targetSubagentSpanId": "<TASK_SPAN_ID>",
    "action": "nudge",
    "status": "applied",
    "message": "Verify the repo root before continuing; repeated glob calls are returning no source files.",
    "reason": "The subagent made repeated empty glob searches and hit a failed read.",
    "source": "opencode-observer",
    "confidence": 0.82
  }'
\`\`\`

Allowed corrective actions: nudge, system_prompt_update, stop, restart.
Allowed statuses: proposed, mock_applied, applied, acknowledged, dismissed, failed. Use applied only if you actually called the OpenCode control endpoint successfully; otherwise use mock_applied.

Before posting:
- State the actual rows returned by the spans, repeated-tool, and error queries.
- If your conclusion contradicts those rows, do not post. Re-query and correct your conclusion.

After posting, summarize exactly what you observed and what steering event you wrote.`;

interface ObserveRequest {
  runId?: string;
  model?: string;
}

interface WorkshopRun {
  id: string;
  event_name?: string | null;
  started_at?: number;
  last_updated_at?: number;
  user_id?: string | null;
  metadata?: string | null;
  finished?: number | null;
}

interface WorkshopSpan {
  id: string;
  parent_span_id?: string | null;
  name?: string | null;
  span_type?: string | null;
  status?: string | null;
  input_payload?: string | null;
  output_payload?: string | null;
  start_time_ms?: number | null;
  end_time_ms?: number | null;
}

interface WorkshopLiveEvent {
  id: number | string;
  trace_id?: string | null;
  span_id?: string | null;
  type?: string | null;
  timestamp?: number | null;
}

interface WorkshopRunDetail {
  spans?: WorkshopSpan[];
  liveEvents?: WorkshopLiveEvent[];
}

interface ObservedRunState {
  runId: string;
  inFlight: boolean;
  passCount: number;
  lastObservedUpdatedAt: number;
  lastStartedAt: number;
  nextObserveAt: number;
  finalObserved: boolean;
  seenSignals: Set<string>;
  lastActivationReason: string | null;
}

let workspaceDir: string | null = null;

function workspace(): string {
  if (workspaceDir) return workspaceDir;
  const dir = path.join(tmpdir(), `raindrop-opencode-observer-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: existsSync(PLUGIN_LINK_TARGET) ? [`file://${PLUGIN_LINK_TARGET}`] : [],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(dir, "README.md"), "# Raindrop Observer Workspace\n\nOpenCode runs here as a traced observer agent.\n");
  workspaceDir = dir;
  return dir;
}

function envForObserver(cwd: string, observedRunId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PWD: cwd,
    HOME: homedir(),
    RAINDROP_LOCAL_DEBUGGER: process.env.RAINDROP_LOCAL_DEBUGGER ?? `${WORKSHOP_BASE}/v1/`,
    RAINDROP_EVENT_METADATA: JSON.stringify({
      eventName: "observer_agent_session",
      userId: "opencode-observer",
      convoId: `observer:${observedRunId}`,
      properties: {
        role: "observer",
        observedRunId,
        observerKind: "llm-as-judge",
      },
    }),
  };
}

function observerPrompt(runId: string, mode: "live" | "final" | "manual" = "live", activationReason = "manual request"): string {
  return `${OBSERVER_SYSTEM_PROMPT}

Observe this run now: ${runId}
Observer pass mode: ${mode}
Activation reason: ${activationReason}

Required procedure:
1. Query the spans for this run from SQLite.
2. Identify subagent task spans and inspect descendant tool calls.
3. Detect repeated no-result searches, failed reads, long idle work, or prompt drift.
4. Find your own observer trace id by querying recent runs with user_id='opencode-observer' or metadata containing observedRunId.
5. If corrective steering is warranted, POST one steering event to ${WORKSHOP_BASE}/api/steering/events and include observerRunId when found.
6. If no corrective steering is warranted, do not post a steering event. Your traced reasoning and tool calls are already visible in Workshop.

Remember: the steering event itself is what makes the nudge visible in Workshop's Observer tab.`;
}

async function runObserverOnce(runId: string, model: string, onChunk: (chunk: Buffer | string) => void, mode: "live" | "final" | "manual" = "live", activationReason = "manual request"): Promise<number> {
  const cwd = workspace();
  const child = spawn("opencode", [
    "run",
    "--format",
    "default",
    "--dangerously-skip-permissions",
    "--model",
    model,
    observerPrompt(runId, mode, activationReason),
  ], {
    cwd,
    env: envForObserver(cwd, runId),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  return new Promise((resolve) => {
    child.once("error", (err) => {
      onChunk(`\n[spawn error] ${err.message}`);
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 0));
  });
}

function shouldTrackRun(run: WorkshopRun, serviceStartedAt: number): boolean {
  if (!run.id || run.event_name !== WATCH_EVENT_NAME) return false;
  if (run.user_id === "opencode-observer") return false;
  try {
    const metadata = run.metadata ? JSON.parse(run.metadata) : null;
    if (metadata?.role === "observer" || metadata?.observedRunId) return false;
  } catch {}
  if (!run.finished) return true;
  return (run.started_at ?? 0) >= serviceStartedAt - 1000;
}

async function getRunDetail(runId: string): Promise<WorkshopRunDetail | null> {
  try {
    const res = await fetch(`${WORKSHOP_BASE}/api/runs/detail/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    return await res.json() as WorkshopRunDetail;
  } catch {
    return null;
  }
}

function shortPayload(value: string | null | undefined, limit = 90): string {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function activationSignals(detail: WorkshopRunDetail | null): { key: string; reason: string }[] {
  const signals: { key: string; reason: string }[] = [];
  const spans = [...(detail?.spans ?? [])].sort((a, b) => (a.start_time_ms ?? 0) - (b.start_time_ms ?? 0));
  for (const span of spans) {
    if (!span.id) continue;
    const type = span.span_type ?? "";
    const name = span.name ?? "span";
    const status = span.status ?? "UNKNOWN";
    const completed = Boolean(span.output_payload || span.end_time_ms || status === "ERROR");
    if (type.includes("LLM")) {
      signals.push({
        key: `llm:${span.id}:${status}:${completed ? "done" : "open"}`,
        reason: `LLM/human turn observed: ${name} ${status}${shortPayload(span.input_payload) ? ` input=${shortPayload(span.input_payload)}` : ""}`,
      });
      continue;
    }
    if (type === "TOOL_CALL") {
      const lowerName = name.toLowerCase();
      const isTask = lowerName === "task" || lowerName.includes("subagent") || lowerName.includes("agent");
      signals.push({
        key: `${isTask ? "handoff" : "tool"}:${span.id}:${status}:${completed ? "done" : "open"}`,
        reason: isTask
          ? `Subagent handoff observed: ${name} ${status}${shortPayload(span.input_payload) ? ` args=${shortPayload(span.input_payload)}` : ""}`
          : `Tool activity observed: ${name} ${status}${status === "ERROR" ? " error" : ""}`,
      });
    }
    if (status === "ERROR") {
      signals.push({
        key: `error:${span.id}`,
        reason: `Error span observed: ${name}${shortPayload(span.output_payload) ? ` output=${shortPayload(span.output_payload)}` : ""}`,
      });
    }
  }
  for (const event of detail?.liveEvents ?? []) {
    if (!event.id) continue;
    signals.push({
      key: `live:${event.id}:${event.type ?? "event"}:${event.span_id ?? ""}`,
      reason: `Live event observed: ${event.type ?? "event"}${event.span_id ? ` on ${event.span_id}` : ""}`,
    });
  }
  return signals;
}

function startAutoWatch(serviceStartedAt: number): { stop: () => void; observed: Map<string, ObservedRunState> } {
  const observed = new Map<string, ObservedRunState>();
  let stopped = false;
  let inFlight = false;

  function stateFor(runId: string): ObservedRunState {
    const existing = observed.get(runId);
    if (existing) return existing;
    const next: ObservedRunState = {
      runId,
      inFlight: false,
      passCount: 0,
      lastObservedUpdatedAt: 0,
      lastStartedAt: 0,
      nextObserveAt: 0,
      finalObserved: false,
      seenSignals: new Set(),
      lastActivationReason: null,
    };
    observed.set(runId, next);
    return next;
  }

  function startPass(run: WorkshopRun, state: ObservedRunState, mode: "live" | "final", activationReason: string, signalKeys: string[] = []) {
    state.inFlight = true;
    state.passCount += 1;
    state.lastStartedAt = Date.now();
    state.nextObserveAt = Date.now() + Math.max(1000, ACTIVE_OBSERVE_MS);
    state.lastActivationReason = activationReason;
    for (const key of signalKeys) state.seenSignals.add(key);
    const pass = state.passCount;
    console.log(`[observer] ${mode} pass ${pass} for ${run.id} (${run.event_name}): ${activationReason}`);
    runObserverOnce(run.id, DEFAULT_MODEL, (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const line of text.split("\n")) {
        if (line.trim()) console.log(`[observer:${run.id.slice(0, 8)}#${pass}] ${line}`);
      }
    }, mode, activationReason).then((code) => {
      state.lastObservedUpdatedAt = run.last_updated_at ?? Date.now();
      if (mode === "final") state.finalObserved = true;
      console.log(`[observer] completed ${mode} pass ${pass} for ${run.id} exit=${code}`);
    }).catch((err) => {
      console.error(`[observer] failed ${mode} pass ${pass} for ${run.id}:`, err);
    }).finally(() => {
      state.inFlight = false;
      state.nextObserveAt = Date.now() + Math.max(1000, ACTIVE_OBSERVE_MS);
    });
  }

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`${WORKSHOP_BASE}/api/runs`);
      if (!res.ok) return;
      const runs = await res.json() as WorkshopRun[];
      const candidates = runs
        .filter((run) => shouldTrackRun(run, serviceStartedAt))
        .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
      for (const run of candidates) {
        const state = stateFor(run.id);
        if (state.inFlight) continue;
        const now = Date.now();
        const runUpdatedAt = run.last_updated_at ?? 0;
        const detail = await getRunDetail(run.id);
        const newSignals = activationSignals(detail).filter((signal) => !state.seenSignals.has(signal.key));
        if (run.finished) {
          if (!state.finalObserved) {
            startPass(
              run,
              state,
              "final",
              newSignals.length > 0
                ? `final pass after run finished; new signals: ${newSignals.map((signal) => signal.reason).slice(0, 4).join("; ")}`
                : "final pass after run finished",
              newSignals.map((signal) => signal.key),
            );
          }
          continue;
        }
        if (newSignals.length > 0) {
          startPass(
            run,
            state,
            "live",
            `new trace activity: ${newSignals.map((signal) => signal.reason).slice(0, 4).join("; ")}`,
            newSignals.map((signal) => signal.key),
          );
          continue;
        }
        if (state.passCount === 0) {
          startPass(run, state, "live", "new active run discovered");
          continue;
        }
        if (runUpdatedAt > state.lastObservedUpdatedAt || now >= state.nextObserveAt) {
          startPass(run, state, "live", now >= state.nextObserveAt ? "active-run heartbeat" : "run updated");
        }
      }
    } catch (err) {
      console.error("[observer] watch poll failed:", err);
    } finally {
      inFlight = false;
    }
  }

  const interval = setInterval(() => { void tick(); }, Math.max(500, WATCH_POLL_MS));
  void tick();
  return {
    observed,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export function createApp(): Express {
  const serviceStartedAt = Date.now();
  const watcher = startAutoWatch(serviceStartedAt);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "opencode-observer-agent",
      workshop: WORKSHOP_BASE,
      db: WORKSHOP_DB_PATH,
      watchingEvent: WATCH_EVENT_NAME,
      model: DEFAULT_MODEL,
      pollMs: WATCH_POLL_MS,
      activeObserveMs: ACTIVE_OBSERVE_MS,
      observedRuns: [...watcher.observed.values()].map((state) => ({
        runId: state.runId,
        inFlight: state.inFlight,
        passCount: state.passCount,
        lastObservedUpdatedAt: state.lastObservedUpdatedAt,
        finalObserved: state.finalObserved,
        seenSignalCount: state.seenSignals.size,
        lastActivationReason: state.lastActivationReason,
      })),
    });
  });

  app.post("/observe", async (req, res) => {
    const body = (req.body ?? {}) as ObserveRequest;
    const runId = body.runId?.trim();
    if (!runId) {
      res.status(400).type("text/plain").send("runId required");
      return;
    }
    const model = body.model?.trim() || DEFAULT_MODEL;

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    const write = (chunk: Buffer | string) => {
      try { res.write(chunk); } catch {}
    };

    const code = await runObserverOnce(runId, model, write, "manual", "manual /observe request");
      write(`\n\n[observer exited ${code ?? 0}]`);
      res.end();
  });

  return app;
}

export async function startServer(port = DEFAULT_PORT): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp();
  return new Promise((resolve) => {
    const server: Server = app.listen(port, () => {
      const addr = server.address() as AddressInfo;
      const actualPort = addr?.port ?? port;
      console.log(`OpenCode Observer Agent: http://localhost:${actualPort}`);
      console.log(`POST /observe with {"runId":"..."}`);
      resolve({
        port: actualPort,
        close: () => new Promise<void>((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

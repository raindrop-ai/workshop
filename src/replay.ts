import { randomUUID } from "crypto";
import type { Response } from "express";
import { getRunWithSpans, upsertRun, updateRunMetadata, countReplaysBySource, findRecentRunByEventName, findRunByEventId, deleteRun } from "./db";
import { getReplayTrace } from "./replay-map";
import { ensureAgentEndpointDetailed, extractContextFromTrace } from "./agents-config";
import type { NormalizedSpan } from "./spans/normalized";

export type ReplayMode = "local";

export interface ReplayConfig {
  sourceRunId: string;
  mode: ReplayMode;
  userMessage?: string;
  model?: string;
  systemPrompt?: string;
  apiKey?: string;
  openaiKey?: string;
  maxIterations?: number;
  contextOverrides?: Record<string, any>;
}

function sendSSE(res: Response, event: string, data: any) {
  res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

const DEFAULT_REPLAY_TRACE_TIMEOUT_MS = 120_000;

function generateReplayRunId(): string {
  return randomUUID();
}

function missingAgentEndpointMessage(eventName: string): string {
  const suffix = eventName ? ` for "${eventName}"` : "";
  return `No local replay agent endpoint found${suffix}. Run /setup-agent-replay in the agent repo, then retry replay.`;
}

/**
 * Pull the conversation context out of a recorded run so we can replay it.
 *
 * Reads from the SDK-agnostic typed view that `getRunWithSpans` attaches to
 * every span via the adapter dispatcher (`src/spans/`); this function only
 * picks the most informative LLM span and reads its fields.
 */
function extractContext(spans: any[]) {
  const allLLMs = spans.filter((s: any) => s.span_type?.includes("LLM"));

  // Pick the LLM span with the longest serialized input — that's almost
  // always the most-recent turn (longest history) and gives the LLM the
  // richest context to continue from.
  const best = allLLMs.reduce(
    (b: any, s: any) => !b || (s.input_payload?.length ?? 0) > (b.input_payload?.length ?? 0) ? s : b,
    null,
  );

  const normalized: NormalizedSpan | undefined = best?.normalized;
  const view = normalized?.kind === "llm" ? normalized : null;

  // Cast to `any[]` for the AI SDK consumer below — `streamText` accepts a
  // tight `ModelMessage` discriminated union that our role-as-string view
  // can't satisfy structurally. The runtime values (string roles + string
  // content) are exactly what `ModelMessage` accepts; the typing gap is
  // purely a TS narrowing limitation. `prepareMessages` and the AI SDK
  // itself enforce the shape from here on.
  const messages = (view?.messages.map((m) => ({ role: m.role, content: m.content })) ?? []) as any[];

  return {
    systemPrompt: view?.systemPrompt && view.systemPrompt.length > 0
      ? view.systemPrompt
      : "You are a helpful assistant.",
    messages,
    model: best?.model ?? view?.model ?? null,
    providerOptions: view?.providerOptions as any,
  };
}

function isReplayProviderMessage(message: any): boolean {
  if (!message || typeof message !== "object") return false;
  if (message.role === "tool") {
    return Array.isArray(message.content) && message.content.length > 0;
  }
  return message.role === "system" || message.role === "user" || message.role === "assistant";
}

function prepareMessages(ctx: ReturnType<typeof extractContext>, userMessage?: string) {
  const allMessages = [...ctx.messages].filter(isReplayProviderMessage);
  let lastUserIdx = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].role === "user") {
      const content = allMessages[i].content;
      const isToolResult = Array.isArray(content) && content.every((c: any) => c.type === "tool_result");
      if (!isToolResult) { lastUserIdx = i; break; }
    }
  }

  if (lastUserIdx >= 0) {
    const messages = allMessages.slice(0, lastUserIdx + 1);
    if (userMessage) messages[messages.length - 1] = { role: "user", content: userMessage };
    return messages;
  }
  return userMessage ? [{ role: "user", content: userMessage }] : allMessages;
}

function setupReplay(config: ReplayConfig, sourceRun: any, broadcast: (event: string, data: any) => void) {
  const sourceRunAny = sourceRun as any;
  const sourceEventName = (sourceRunAny.event_name ?? "unknown").replace(/^replay:/, "");
  const replayEventName = `replay:${sourceEventName}`;
  const replayRunId = generateReplayRunId();
  const now = Date.now();
  const replayCount = countReplaysBySource(config.sourceRunId) + 1;

  const replayName = `Replay of ${sourceEventName}-${config.sourceRunId.slice(0, 4)} (#${replayCount})`;

  // Create a placeholder run in DB so the URL the UI navigates to (`/runs/<replayRunId>`)
  // always resolves to something. If stitching to the agent's OTLP run succeeds
  // (the common case), we'll redirect the UI to that run on `replay_complete`.
  // If stitching fails — agent crashed before any span shipped, agent didn't echo
  // replayRunId back, etc. — the user lands on an empty placeholder row instead
  // of a "Run not found" wall.
  upsertRun({
    id: replayRunId,
    name: replayName,
    event_name: replayEventName,
    started_at: now,
    last_updated_at: now,
    metadata: JSON.stringify({ replay: { sourceRunId: config.sourceRunId, mode: config.mode, model: config.model ?? null, overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt } } }),
  });
  broadcast("spans", { runIds: [replayRunId] });

  return { replayRunId, replayEventName, sourceEventName, replayName, now };
}

function recordPlaceholderError(
  replayRunId: string,
  config: ReplayConfig,
  error: { code: string; message: string; status?: number },
  broadcast?: (event: string, data: any) => void,
): void {
  updateRunMetadata(replayRunId, JSON.stringify({
    replay: {
      sourceRunId: config.sourceRunId,
      mode: config.mode,
      model: config.model ?? null,
      overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt },
      error: { ...error, at: Date.now() },
    },
  }));
  // RunDetail listens for "spans" and refetches when its runId matches.
  broadcast?.("spans", { runIds: [replayRunId] });
}

function statusErrorMessage(body: any): string {
  const raw = body?.message ?? body?.error ?? body?.reason;
  if (typeof raw === "string" && raw.trim()) return raw;
  if (raw instanceof Error) return raw.message;
  return "Agent replay failed.";
}

export function promoteLocalReplayRun(args: {
  placeholderRunId: string;
  otlpRunId: string;
  replayMetadata: string;
  replayName: string;
}): string {
  const otlpRun = getRunWithSpans(args.otlpRunId).run as any;
  if (!otlpRun) return args.placeholderRunId;

  updateRunMetadata(args.otlpRunId, args.replayMetadata);
  upsertRun({
    id: args.otlpRunId,
    name: args.replayName,
    started_at: otlpRun.started_at,
    last_updated_at: otlpRun.last_updated_at,
  });
  if (args.placeholderRunId !== args.otlpRunId) {
    deleteRun(args.placeholderRunId);
  }
  return args.otlpRunId;
}

async function runLocalAgentReplay(
  config: ReplayConfig, res: Response, broadcast: (event: string, data: any) => void,
): Promise<void> {
  const { run: sourceRun, spans: sourceSpans } = getRunWithSpans(config.sourceRunId);
  if (!sourceRun) {
    sendSSE(res, "error", { code: "source_run_not_found", message: "Source run not found" });
    res.end();
    return;
  }

  const sourceRunAny = sourceRun as any;
  const eventName = (sourceRunAny.event_name ?? "").replace(/^replay:/, "");
  const endpoint = await ensureAgentEndpointDetailed(eventName);
  const agentConfig = endpoint.config;
  if (!agentConfig?.url) {
    if (endpoint.registered) {
      sendSSE(res, "error", {
        code: "replay_agent_start_failed",
        setupRequired: false,
        eventName,
        message:
          `Registered replay agent "${eventName}" was found, but Workshop could not reach its /health endpoint` +
          (endpoint.attemptedStart && endpoint.command ? ` after starting \`${endpoint.command}\`` : "") +
          ".",
        suggestedAction: endpoint.logPath
          ? `Check ${endpoint.logPath}, then retry replay.`
          : "Start the replay server manually, then retry replay.",
        command: endpoint.command,
        cwd: endpoint.cwd,
        logPath: endpoint.logPath,
        attemptedStart: endpoint.attemptedStart,
      });
      res.end();
      return;
    }
    sendSSE(res, "error", {
      code: "missing_replay_agent",
      setupRequired: true,
      eventName,
      message: missingAgentEndpointMessage(eventName),
      suggestedAction: "Run /setup-agent-replay in the agent repo.",
    });
    res.end();
    return;
  }

  const ctx = extractContext(sourceSpans);
  const messages = prepareMessages(ctx, config.userMessage);
  const { replayRunId, replayEventName, replayName, now } = setupReplay(config, sourceRun, broadcast);
  sendSSE(res, "replay_started", { replayRunId, sourceRunId: config.sourceRunId, mode: "local" });

  // Extract agent-specific context from trace, then apply overrides
  const prefillMapping = agentConfig.prefillFromTrace ?? agentConfig.contextFromTrace;
  const agentContext = prefillMapping
    ? extractContextFromTrace(sourceSpans, prefillMapping)
    : {};
  if (config.contextOverrides) Object.assign(agentContext, config.contextOverrides);

  let agentError = false;
  let agentReplayId: string | null = null;

  try {
    sendSSE(res, "llm_start", { iteration: 1 });

    const agentResp = await fetch(agentConfig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRunId: config.sourceRunId,
        replayRunId,
        messages,
        systemPrompt: config.systemPrompt ?? ctx.systemPrompt,
        userMessage: config.userMessage,
        model: config.model,
        providerOptions: ctx.providerOptions,
        context: agentContext,
      }),
    });

    if (!agentResp.ok) {
      const err = await agentResp.text();
      const message = `Agent endpoint error (${agentResp.status}): ${err}`;
      recordPlaceholderError(replayRunId, config, { code: "agent_http_error", message, status: agentResp.status }, broadcast);
      sendSSE(res, "error", { code: "agent_http_error", status: agentResp.status, message });
      agentError = true;
    } else {
      let body: any;
      try {
        body = await agentResp.json();
      } catch (err: any) {
        const message = `Agent returned a non-JSON response: ${err.message}`;
        recordPlaceholderError(replayRunId, config, { code: "agent_bad_response", message }, broadcast);
        sendSSE(res, "error", { code: "agent_bad_response", message });
        agentError = true;
      }
      if (!agentError) {
        if (body.error) {
          const message = body.message ?? "Agent returned an error";
          recordPlaceholderError(replayRunId, config, { code: "agent_returned_error", message }, broadcast);
          sendSSE(res, "error", { code: "agent_returned_error", message, stack: body.stack });
          agentError = true;
        } else if (body.status === "error" || body.status === "failed") {
          const code = body.code ?? "agent_replay_failed";
          const message = statusErrorMessage(body);
          recordPlaceholderError(replayRunId, config, { code, message }, broadcast);
          sendSSE(res, "error", { code, message, stack: body.stack });
          agentError = true;
        } else {
          agentReplayId = typeof body.replayId === "string" ? body.replayId : null;
          sendSSE(res, "agent_started", { replayId: agentReplayId });
        }
      }
    }
  } catch (err: any) {
    const message = `Failed to call agent endpoint: ${err.message}`;
    recordPlaceholderError(replayRunId, config, { code: "agent_unreachable", message }, broadcast);
    sendSSE(res, "error", { code: "agent_unreachable", message });
    agentError = true;
  }

  if (!agentError) {
    // Poll the replay map for the real OTLP run ID.
    // The agent sends traces with replayRunId in metadata; when the first
    // batch arrives, the ingest handler records the mapping.
    const maxWaitMs = DEFAULT_REPLAY_TRACE_TIMEOUT_MS;
    const pollMs = 500;
    const deadline = Date.now() + maxWaitMs;
    let otlpRunId: string | undefined;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      otlpRunId = getReplayTrace(replayRunId) ?? findRunByEventId(replayRunId)?.id;
      if (otlpRunId) break;
    }

    if (otlpRunId) {
      const replayMeta = JSON.stringify({
        replay: { sourceRunId: config.sourceRunId, mode: config.mode, model: config.model ?? null, overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt } },
      });
      const finalRunId = promoteLocalReplayRun({
        placeholderRunId: replayRunId,
        otlpRunId,
        replayMetadata: replayMeta,
        replayName,
      });
      broadcast("spans", { runIds: [finalRunId] });
      sendSSE(res, "replay_complete", { replayRunId: finalRunId, iterations: 0, toolCallCount: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });
    } else {
      // Fallback: try the old event-name heuristic.
      const otlpRun = findRecentRunByEventName(replayEventName, now - 5000, replayRunId);
      let finalRunId = replayRunId;
      if (otlpRun) {
        const replayMeta = JSON.stringify({
          replay: { sourceRunId: config.sourceRunId, mode: config.mode, model: config.model ?? null, overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt } },
        });
        updateRunMetadata(otlpRun.id, replayMeta);
        upsertRun({ id: otlpRun.id, name: replayName, started_at: (otlpRun as any).started_at, last_updated_at: (otlpRun as any).last_updated_at });
        finalRunId = otlpRun.id;
        broadcast("spans", { runIds: [finalRunId] });
        sendSSE(res, "replay_complete", { replayRunId: finalRunId, iterations: 0, toolCallCount: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });
      } else {
        const message = `Agent accepted replay${agentReplayId ? ` ${agentReplayId}` : ""}, but Workshop did not receive a replay trace within ${Math.round(maxWaitMs / 1000)}s.`;
        recordPlaceholderError(replayRunId, config, { code: "replay_timeout", message }, broadcast);
        sendSSE(res, "error", {
          code: "replay_timeout",
          message,
          replayRunId,
          replayId: agentReplayId,
        });
      }
    }
  }

  res.end();
}

export async function runReplay(
  config: ReplayConfig,
  res: Response,
  broadcast: (event: string, data: any) => void,
): Promise<void> {
  return runLocalAgentReplay(config, res, broadcast);
}

export const _internal = {
  generateReplayRunId,
  recordPlaceholderError,
};

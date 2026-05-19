import { normalizeOtelId } from "./ids";
import { normalizeSpan } from "./spans/normalize";
import type { NormalizedSpan } from "./spans/normalized";

export interface ParsedSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; spanType: string;
  status: string; inputPayload?: string; outputPayload?: string; startTimeMs: number;
  endTimeMs: number; durationMs: number; model?: string; provider?: string;
  inputTokens?: number; outputTokens?: number; attributes: Record<string, string | number | boolean>;
  eventId?: string; eventName?: string; userId?: string; convoId?: string;
  replayRunId?: string;
  /**
   * SDK-agnostic typed view of this span. Computed via the adapter dispatcher
   * at ingest time so consumers (replay engine, UI, MCP tools) read typed
   * fields without re-parsing `input_payload` strings. See `src/spans/`.
   */
  normalized: NormalizedSpan;
}

function getAttr(attrs: any[], key: string): string | number | boolean | undefined {
  const a = attrs?.find((x: any) => x.key === key);
  if (!a?.value) return undefined;
  if (a.value.stringValue !== undefined) return a.value.stringValue;
  if (a.value.intValue !== undefined) return Number(a.value.intValue);
  if (a.value.doubleValue !== undefined) return a.value.doubleValue;
  if (a.value.boolValue !== undefined) return a.value.boolValue;
  return undefined;
}

function first(attrs: any[], ...keys: string[]): string | number | boolean | undefined {
  for (const k of keys) { const v = getAttr(attrs, k); if (v !== undefined) return v; }
  return undefined;
}

function inferSpanType(
  operationId?: string,
  traceloopKind?: string,
  hasToolName = false,
  raindropSpanKind?: string,
  attrs: Record<string, string | number | boolean> = {},
): "LLM_GENERATION" | "TOOL_CALL" | "AGENT_ROOT" | "TRACE" | "INTERNAL" {
  // The SDK is the source of truth when it has declared a role explicitly via
  // `raindrop.span.kind`. Trusting the tag — instead of pattern-matching on
  // operation names — is what lets Workshop be a "dumb" consumer: the
  // `@raindrop-ai/ai-sdk` wrapper stamps every span it emits with one of
  // agent_root / llm_call / tool_call, and we honor that exactly.
  if (raindropSpanKind === "agent_root") return "AGENT_ROOT";
  if (raindropSpanKind === "trace") return "TRACE";
  if (raindropSpanKind === "llm_call") return "LLM_GENERATION";
  if (raindropSpanKind === "tool_call") return "TOOL_CALL";

  // Fallback heuristics for spans that don't carry `raindrop.span.kind` —
  // older SDK versions, third-party AI SDKs, raw Traceloop instrumentation,
  // bedrock SDKs, etc. Once everyone is on a recent `@raindrop-ai/*` we can
  // shrink this further.
  if (hasToolName) return "TOOL_CALL";
  if (traceloopKind === "tool") return "TOOL_CALL";
  if (traceloopKind === "llm") return "LLM_GENERATION";
  if (isGenAiInferenceSpan(attrs)) return "LLM_GENERATION";
  if (typeof attrs["lk.chat_ctx"] === "string") return "LLM_GENERATION";
  if (typeof operationId === "string") {
    if (operationId === "ai.toolCall") return "TOOL_CALL";
    if (operationId === "chat" || operationId === "llm" || operationId === "generation" || operationId === "response") return "LLM_GENERATION";
    if (operationId === "ConverseCommand" || operationId === "InvokeModelCommand") return "LLM_GENERATION";
    if (operationId.includes("Stream") || operationId.includes("Generate") ||
        operationId.includes("stream") || operationId.includes("generate")) return "LLM_GENERATION";
  }
  return "INTERNAL";
}

function isGenAiInferenceSpan(attrs: Record<string, string | number | boolean>): boolean {
  const operationName = attrs["gen_ai.operation.name"];
  if (
    operationName === "chat" ||
    operationName === "text_completion" ||
    operationName === "generate_content"
  ) {
    return true;
  }

  // Legacy OpenLLMetry provider spans emitted this shape before the current
  // OTel GenAI message attributes existed. Treat chat/completion calls as LLMs,
  // but avoid broad `gen_ai.*` matching so embeddings/retrievals remain INTERNAL
  // until Workshop supports them explicitly.
  const requestType = attrs["llm.request.type"];
  if (requestType === "chat" || requestType === "completion") return true;

  return hasIndexedAttr(attrs, "gen_ai.prompt.") || hasIndexedAttr(attrs, "gen_ai.completion.");
}

function hasIndexedAttr(attrs: Record<string, string | number | boolean>, prefix: string): boolean {
  return Object.keys(attrs).some((key) => key.startsWith(prefix));
}

function status(code: number | undefined): string {
  if (code === 1) return "OK";
  if (code === 2) return "ERROR";
  // OTel spec: UNSET is the default for ended spans that completed without
  // an explicit error. Instrumentation libraries are only supposed to call
  // setStatus(OK) to override an explicit ERROR — most (Vercel AI SDK,
  // Traceloop) leave successful spans at UNSET. Workshop only ever sees
  // ended spans (OTel exports on end), so coerce UNSET → OK so downstream
  // "is this run finished?" logic doesn't get stuck waiting for an explicit
  // OK that's never coming. Manual-SDK synthetic spans that legitimately
  // mean "still in flight" go through `upsertEventSpan` directly, not this
  // path, so their UNSET-during-begin signal is preserved.
  return "OK";
}

function spanErrorMessage(span: any): string | undefined {
  if (typeof span.status?.message === "string" && span.status.message) {
    return span.status.message;
  }

  for (const event of span.events ?? []) {
    const attrs = event.attributes ?? [];
    const message = first(attrs, "exception.message", "message");
    if (typeof message === "string" && message) return message;
  }

  return undefined;
}

export function parseOtlpRequest(body: any): ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  if (!body?.resourceSpans) return spans;
  for (const rs of body.resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attrs = s.attributes ?? [];
        const startNs = BigInt(s.startTimeUnixNano || "0");
        const endNs = BigInt(s.endTimeUnixNano || "0");
        const startMs = Number(startNs / 1_000_000n);
        const endMs = Number(endNs / 1_000_000n);
        const allAttrs: Record<string, string | number | boolean> = {};
        for (const a of attrs) { const v = getAttr([a], a.key); if (v !== undefined) allAttrs[a.key] = v; }
        if (typeof s.status?.code === "number") allAttrs["otel.status.code"] = s.status.code;
        const errorMessage = spanErrorMessage(s);
        if (errorMessage) allAttrs["otel.status.message"] = errorMessage;

        const operationId = getAttr(attrs, "ai.operationId") as string | undefined;
        const traceloopKind = getAttr(attrs, "traceloop.span.kind") as string | undefined;
        const raindropSpanKind = getAttr(attrs, "raindrop.span.kind") as string | undefined;
        const toolCallName = first(attrs, "ai.toolCall.name", "tool.name", "lk.function_tool.name") as string | undefined;
        const spanType = inferSpanType(operationId, traceloopKind, !!toolCallName, raindropSpanKind, allAttrs);

        // For tool calls, prefer the actual tool name over generic wrapper
        // span names like "ai.toolCall" or Traceloop's "foo.tool".
        let name = s.name as string;
        if (toolCallName) name = toolCallName;
        else if (spanType === "TOOL_CALL" && traceloopKind === "tool") {
          const traceloopEntityName = getAttr(attrs, "traceloop.entity.name") as string | undefined;
          name = traceloopEntityName || name.replace(/\.tool$/, "");
        }

        // Adapters know which attributes hold the canonical input/output payload
        // for their SDK and produce a typed `normalized` view in a single pass,
        // so downstream consumers don't need to coalesce or try/catch-and-guess.
        const match = normalizeSpan({
          spanName: name,
          attrs: allAttrs,
          spanType,
          operationId,
          traceloopKind,
        });

        let inputPayload = match.inputPayload;
        let outputPayload = match.outputPayload;

        // Fallback for spans no adapter recognized — e.g. internal Express
        // middleware or otel-instrumented HTTP calls — so the "raw view" tab
        // still has something to render.
        if (inputPayload === undefined && outputPayload === undefined) {
          inputPayload = first(attrs, "traceloop.entity.input", "tool.input") as string | undefined;
          outputPayload = first(attrs, "traceloop.entity.output", "tool.output") as string | undefined;
        }

        const model = first(attrs, "ai.model.id", "ai.response.model", "gen_ai.request.model", "gen_ai.response.model", "llm.request.model") as string | undefined;
        const provider = first(attrs, "ai.model.provider", "gen_ai.system", "gen_ai.provider.name", "llm.system") as string | undefined;
        const inputTokens = first(attrs, "ai.usage.inputTokens", "ai.usage.promptTokens", "ai.usage.prompt_tokens", "gen_ai.usage.input_tokens") as number | undefined;
        const outputTokens = first(attrs, "ai.usage.outputTokens", "ai.usage.completionTokens", "ai.usage.completion_tokens", "gen_ai.usage.output_tokens") as number | undefined;

        const eventId = first(attrs, "ai.telemetry.metadata.raindrop.eventId", "ai.telemetry.metadata.traceloop.association.properties.event_id", "traceloop.association.properties.event_id", "traceloop.association.properties.traceloop.association.properties.event_id") as string | undefined;
        const eventName = first(attrs, "ai.telemetry.metadata.raindrop.eventName", "ai.telemetry.metadata.traceloop.association.properties.event_name", "traceloop.association.properties.event_name", "traceloop.association.properties.traceloop.association.properties.event_name") as string | undefined;
        const userId = first(attrs, "ai.telemetry.metadata.raindrop.userId", "ai.telemetry.metadata.raindrop.ai.userId", "ai.telemetry.metadata.traceloop.association.properties.user_id", "traceloop.association.properties.user_id", "traceloop.association.properties.traceloop.association.properties.user_id") as string | undefined;
        const convoId = first(attrs, "ai.telemetry.metadata.raindrop.convoId", "ai.telemetry.metadata.traceloop.association.properties.convo_id", "traceloop.association.properties.convo_id", "traceloop.association.properties.traceloop.association.properties.convo_id") as string | undefined;
        // replayRunId is the canonical "this run is a replay of <placeholder>" stitch key.
        // Workshop's UI sets it on every replay; the agent must echo it back so we can match
        // its OTLP traces to the placeholder run created at click-time.
        //
        // Three emission paths, all supported here:
        //   1. Top-level attribute  — AI SDK callers who hand-inject `"raindrop.replayRunId"`
        //      into `experimental_telemetry.metadata`. Cheap, but no SDK exposes it directly,
        //      so few users hit this path.
        //   2. Manual SDK association properties — the `raindrop-ai` package emits user
        //      properties as `traceloop.association.properties.*`.
        //   3. Inside the JSON-serialized `raindrop.properties` blob — the only path available
        //      to `@raindrop-ai/claude-agent-sdk` users (no escape hatch for arbitrary attrs)
        //      and the natural fit for AI SDK users too (`eventMetadata({ properties: { replayRunId } })`).
        //      We crack open the JSON and look for `replayRunId` here so the canonical contract
        //      is "put it in properties" — works across every SDK wrapper.
        let replayRunId = first(
          attrs,
          "ai.telemetry.metadata.raindrop.replayRunId",
          "traceloop.association.properties.replayRunId",
        ) as string | undefined;
        if (!replayRunId) {
          const propsStr = getAttr(attrs, "ai.telemetry.metadata.raindrop.properties") as string | undefined;
          if (propsStr) {
            try {
              const props = JSON.parse(propsStr);
              if (props && typeof props.replayRunId === "string" && props.replayRunId) {
                replayRunId = props.replayRunId;
              }
            } catch { /* properties wasn't JSON; nothing to do */ }
          }
        }

        spans.push({
          traceId: normalizeOtelId(s.traceId, 16) ?? s.traceId,
          spanId: normalizeOtelId(s.spanId, 8) ?? s.spanId,
          parentSpanId:
            normalizeOtelId(s.parentSpanId || undefined, 8) ??
            s.parentSpanId ??
            undefined,
          name, spanType,
          status: status(s.status?.code),
          inputPayload, outputPayload,
          startTimeMs: startMs, endTimeMs: endMs,
          durationMs: (getAttr(attrs, "traceloop.entity.duration_ms") as number) ?? (endMs - startMs),
          model, provider,
          inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
          outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
          attributes: allAttrs,
          eventId, eventName, userId, convoId, replayRunId,
          normalized: match.normalized,
        });
      }
    }
  }
  return spans;
}

import { z } from "zod";
import {
  getCachedCloudTraceSpans,
  setCloudTraceCache,
} from "./saved-runs";
import type { Run, Span, SubAgent } from "../utils/types";

const signalSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const queryEventSchema = z.object({
  id: z.string(),
  event_name: z.string(),
  user_id: z.string().nullable(),
  convo_id: z.string().nullable(),
  timestamp: z.string(),
  user_input: z.string().nullable(),
  assistant_output: z.string().nullable(),
  signals: z.array(z.object({
    id: z.string(),
    name: z.string(),
    score: z.number().optional(),
  })).optional(),
  relevance_score: z.number().optional(),
});

const traceSpanSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  span_name: z.string(),
  span_type: z.string(),
  status: z.string(),
  start_time_ns: z.number(),
  end_time_ns: z.number(),
  duration_ns: z.number(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])),
});

const pageMetaSchema = z.object({
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export type Signal = z.infer<typeof signalSchema>;
export type QueryEvent = z.infer<typeof queryEventSchema>;
export type TraceSpan = z.infer<typeof traceSpanSchema>;
export type SearchMode = "text" | "semantic" | "regex";

async function queryApiFetch<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
  const proxyPath = path.replace(/^\/v1/, "/api/query");
  const url = new URL(proxyPath, window.location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? body?.error ?? `API error ${res.status}`);
  }
  const json = await res.json();
  return schema.parse(json);
}

export async function fetchSignals(): Promise<Signal[]> {
  const res = await queryApiFetch("/v1/signals", { limit: "100" }, z.object({ data: z.array(signalSchema) }));
  return res.data;
}

export async function searchEvents(opts: {
  query: string; mode: SearchMode; signal?: string; limit?: number;
  cursor?: string; timestampGte?: string; timestampLt?: string;
}): Promise<{ data: QueryEvent[]; meta: { cursor: string | null; has_more: boolean } }> {
  const params: Record<string, string> = { query: opts.query, mode: opts.mode, limit: String(opts.limit ?? 25) };
  if (opts.signal) params.signal = opts.signal;
  if (opts.cursor) params.cursor = opts.cursor;
  if (opts.timestampGte) params["timestamp[gte]"] = opts.timestampGte;
  if (opts.timestampLt) params["timestamp[lt]"] = opts.timestampLt;
  return queryApiFetch("/v1/events/search", params, z.object({
    data: z.array(queryEventSchema),
    meta: pageMetaSchema,
  }));
}

export async function listEvents(opts: {
  signal?: string; convoId?: string; limit?: number; cursor?: string;
  timestampGte?: string; timestampLt?: string; orderBy?: string;
}): Promise<{ data: QueryEvent[]; meta: { cursor: string | null; has_more: boolean } }> {
  const params: Record<string, string> = { limit: String(opts.limit ?? 25), order_by: opts.orderBy ?? "-timestamp" };
  if (opts.signal) params.signal = opts.signal;
  if (opts.convoId) params.convo_id = opts.convoId;
  if (opts.cursor) params.cursor = opts.cursor;
  if (opts.timestampGte) params["timestamp[gte]"] = opts.timestampGte;
  if (opts.timestampLt) params["timestamp[lt]"] = opts.timestampLt;
  return queryApiFetch("/v1/events", params, z.object({
    data: z.array(queryEventSchema),
    meta: pageMetaSchema,
  }));
}

export async function fetchTraceSpans(eventId: string): Promise<TraceSpan[]> {
  const res = await queryApiFetch("/v1/traces", { event_id: eventId, limit: "500" }, z.object({ data: z.array(traceSpanSchema) }));
  return res.data;
}

export async function getCloudSpans(eventId: string): Promise<Span[]> {
  const cachedSpans = await getCachedCloudTraceSpans(eventId);
  if (cachedSpans) return cachedSpans;

  const traces = await fetchTraceSpans(eventId);
  const spans = mapTraceToSpans(traces, eventId);
  await setCloudTraceCache(eventId, spans);
  return spans;
}

export function buildCloudRun(event: QueryEvent, spans: Span[]): Run {
  const eventTime = new Date(event.timestamp).getTime();
  const startMs = spans.length > 0 ? Math.min(...spans.map(s => s.start_time_ms)) : eventTime;
  const endMs = spans.length > 0 ? Math.max(...spans.map(s => s.end_time_ms)) : eventTime;
  return {
    id: event.id,
    name: null,
    event_name: event.event_name,
    user_id: event.user_id,
    convo_id: event.convo_id,
    started_at: startMs,
    last_updated_at: endMs,
    metadata: null,
    model: spans.find(s => s.model)?.model ?? null,
    finished: 1,
  };
}

export function mapTraceToSpans(traces: TraceSpan[], eventId: string): Span[] {
  return traces.map(t => {
    let inputPayload = t.input;
    let outputPayload = t.output;
    if (t.span_type.includes("LLM")) {
      const aiPrompt = t.attributes["ai.prompt"];
      if (typeof aiPrompt === "string") inputPayload = aiPrompt;
      const aiResponseText = t.attributes["ai.response.text"];
      if (typeof aiResponseText === "string" && !outputPayload) outputPayload = aiResponseText;
    }
    return {
      id: t.span_id,
      run_id: eventId,
      parent_span_id: t.parent_span_id,
      name: t.span_name,
      span_type: t.span_type,
      status: t.status,
      input_payload: inputPayload,
      output_payload: outputPayload,
      start_time_ms: t.start_time_ns / 1e6,
      end_time_ms: t.end_time_ns / 1e6,
      duration_ms: t.duration_ns / 1e6,
      model: t.model,
      provider: t.provider,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      attributes: Object.keys(t.attributes).length > 0 ? JSON.stringify(t.attributes) : null,
    };
  });
}

export function detectSubAgents(spans: Span[]): SubAgent[] {
  const children = new Map<string, Span[]>();
  const spanMap = new Map<string, Span>();
  for (const s of spans) {
    spanMap.set(s.id, s);
    if (s.parent_span_id) {
      const kids = children.get(s.parent_span_id) ?? [];
      kids.push(s);
      children.set(s.parent_span_id, kids);
    }
  }

  const agents: SubAgent[] = [];
  for (const span of spans) {
    if (span.span_type !== "TOOL_CALL") continue;
    const kids = children.get(span.id) ?? [];
    const llmKids = kids.filter(k => k.span_type?.includes("LLM"));
    let hasAgenticLoop = false;
    for (const llm of llmKids) {
      const grandkids = children.get(llm.id) ?? [];
      if (grandkids.some(g => g.span_type === "TOOL_CALL")) { hasAgenticLoop = true; break; }
      if (llm.name === "agent.subagent") { hasAgenticLoop = true; break; }
    }
    if (!hasAgenticLoop) continue;

    const allSpanIds: string[] = [];
    const collected = new Set<string>();
    let llmCount = 0, toolCount = 0, totalIn = 0, totalOut = 0;
    let model: string | null = null;
    function collect(id: string) {
      if (collected.has(id)) return;
      collected.add(id);
      allSpanIds.push(id);
      const s = spanMap.get(id);
      if (s) {
        if (s.span_type?.includes("LLM")) {
          llmCount++;
          if (!model && s.model) model = s.model;
          totalIn += s.input_tokens ?? 0;
          totalOut += s.output_tokens ?? 0;
        }
        if (s.span_type === "TOOL_CALL" && s.id !== span.id) toolCount++;
      }
      for (const kid of children.get(id) ?? []) collect(kid.id);
    }
    collect(span.id);

    agents.push({
      root_span_id: span.id,
      name: span.name,
      span_ids: allSpanIds,
      start_time_ms: span.start_time_ms,
      end_time_ms: span.end_time_ms,
      duration_ms: span.duration_ms,
      model,
      status: span.status,
      llm_count: llmCount,
      tool_count: toolCount,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
    });
  }
  return agents;
}

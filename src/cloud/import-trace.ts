import { eq } from "drizzle-orm";
import { getDrizzleDb, getRunById } from "../db";
import * as schema from "../db/schema";
import { normalizeSpan } from "../spans/normalize";
import type { AdapterInput } from "../spans/adapters/types";
import { getQueryEvent, getQueryTraceSpans, type QueryEvent, type QueryTraceSpan } from "./query-client";

export const MAX_IMPORTED_TRACE_SPANS = 999;
export const MAX_IMPORTED_TRACE_PAYLOAD_BYTES = 10 * 1024 * 1024;

const PAYLOAD_BYTE_CONVERGENCE_ITERATIONS = 4;

export type ImportCloudTraceStatus = "created" | "updated";
export type ImportCloudTraceRefusalReason = "no_spans" | "too_many_spans" | "too_many_bytes";

export interface ImportCloudTraceResult {
  status: ImportCloudTraceStatus;
  run_id: string;
  event_id: string;
  event_name: string;
  span_count: number;
  payload_bytes: number;
  was_present: boolean;
}

export class ImportCloudTraceRefused extends Error {
  constructor(
    readonly reason: ImportCloudTraceRefusalReason,
    readonly observed: number,
    readonly limit: number,
    message: string,
  ) {
    super(message);
    this.name = "ImportCloudTraceRefused";
  }
}

interface ProductionTiming {
  prodStartedAt: number;
  prodEndedAt: number;
}

function stringAttr(attrs: Record<string, string | number>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" ? value : undefined;
}

function adapterSpanType(spanType: string): AdapterInput["spanType"] {
  if (spanType === "LLM_GENERATION" || spanType.includes("LLM")) return "LLM_GENERATION";
  if (spanType === "TOOL_CALL" || spanType.includes("TOOL")) return "TOOL_CALL";
  if (spanType === "AGENT_ROOT") return "AGENT_ROOT";
  if (spanType === "TRACE") return "TRACE";
  return "INTERNAL";
}

function payloadsForSpan(span: QueryTraceSpan): { inputPayload: string | null; outputPayload: string | null } {
  const attrs = span.attributes ?? {};
  const isLlm = span.span_type.includes("LLM");
  const normalized = normalizeSpan({
    spanName: span.span_name,
    spanType: adapterSpanType(span.span_type),
    attrs,
    inputPayload: span.input ?? undefined,
    outputPayload: span.output ?? undefined,
    operationId: stringAttr(attrs, "ai.operationId"),
    traceloopKind: stringAttr(attrs, "traceloop.span.kind"),
  });
  return {
    inputPayload: normalized.inputPayload
      ?? (isLlm ? stringAttr(attrs, "ai.prompt") : undefined)
      ?? span.input,
    outputPayload: normalized.outputPayload
      ?? (isLlm ? stringAttr(attrs, "ai.response.text") : undefined)
      ?? span.output,
  };
}

function spanRow(span: QueryTraceSpan, runId: string) {
  const { inputPayload, outputPayload } = payloadsForSpan(span);
  const attrs = span.attributes ?? {};
  return {
    id: span.span_id,
    run_id: runId,
    parent_span_id: span.parent_span_id ?? null,
    name: span.span_name,
    span_type: span.span_type,
    status: span.status ?? "UNSET",
    input_payload: inputPayload,
    output_payload: outputPayload,
    start_time_ms: span.start_time_ns / 1e6,
    end_time_ms: span.end_time_ns / 1e6,
    duration_ms: span.duration_ns / 1e6,
    model: span.model,
    provider: span.provider,
    input_tokens: span.input_tokens,
    output_tokens: span.output_tokens,
    attributes: Object.keys(attrs).length ? JSON.stringify(attrs) : null,
  };
}

type SpanInsertRow = ReturnType<typeof spanRow>;

function productionTiming(spans: QueryTraceSpan[]): ProductionTiming {
  let prodStartedAt = Infinity;
  let prodEndedAt = -Infinity;
  for (const span of spans) {
    const start = span.start_time_ns / 1e6;
    const end = span.end_time_ns / 1e6;
    if (start < prodStartedAt) prodStartedAt = start;
    if (end > prodEndedAt) prodEndedAt = end;
  }
  return { prodStartedAt, prodEndedAt };
}

function runMetadataJson(
  event: QueryEvent,
  timing: ProductionTiming,
  importedAt: string,
  payloadBytes: number,
): string {
  return JSON.stringify({
    source: "raindrop_cloud",
    query_event_id: event.id,
    imported_at: importedAt,
    prod_started_at: timing.prodStartedAt,
    prod_ended_at: timing.prodEndedAt,
    payload_bytes: payloadBytes,
    signals: event.signals ?? [],
    properties: event.properties ?? {},
  });
}

function byteLength(value: string | null | undefined): number {
  return value ? Buffer.byteLength(value, "utf8") : 0;
}

function spanPayloadBytes(spanRows: SpanInsertRow[]): number {
  let total = 0;
  for (const span of spanRows) {
    total += byteLength(span.input_payload);
    total += byteLength(span.output_payload);
    total += byteLength(span.attributes);
  }
  return total;
}

function refuseIfTooLarge(totalBytes: number): void {
  if (totalBytes > MAX_IMPORTED_TRACE_PAYLOAD_BYTES) {
    throw new ImportCloudTraceRefused(
      "too_many_bytes",
      totalBytes,
      MAX_IMPORTED_TRACE_PAYLOAD_BYTES,
      `Trace payload is too large to import (${totalBytes} bytes > ${MAX_IMPORTED_TRACE_PAYLOAD_BYTES}).`,
    );
  }
}

/**
 * Build run metadata whose `payload_bytes` includes the metadata itself. The
 * metadata size depends on the digit count of `payload_bytes`, so we iterate
 * until the reported value matches the actual serialized size. Convergence is
 * fast — payload_bytes increases monotonically across iterations and its digit
 * count only grows when crossing a power of 10, so the loop is guaranteed to
 * converge in 2 iterations in practice. If it ever fails to converge within
 * the bound we throw instead of returning metadata whose embedded
 * `payload_bytes` disagrees with the value we report.
 */
function buildRunMetadata(
  event: QueryEvent,
  timing: ProductionTiming,
  spanRows: SpanInsertRow[],
): { payloadBytes: number; metadata: string } {
  const importedAt = new Date().toISOString();
  const spansBytes = spanPayloadBytes(spanRows);
  let payloadBytes = spansBytes;
  let metadata = runMetadataJson(event, timing, importedAt, payloadBytes);
  for (let i = 0; i < PAYLOAD_BYTE_CONVERGENCE_ITERATIONS; i++) {
    const nextPayloadBytes = spansBytes + byteLength(metadata);
    if (nextPayloadBytes === payloadBytes) {
      refuseIfTooLarge(payloadBytes);
      return { payloadBytes, metadata };
    }
    payloadBytes = nextPayloadBytes;
    metadata = runMetadataJson(event, timing, importedAt, payloadBytes);
  }
  throw new Error(
    `Workshop bug: payload_bytes metadata failed to converge after ${PAYLOAD_BYTE_CONVERGENCE_ITERATIONS} iterations`,
  );
}

function runRow(event: QueryEvent, prodStartedAt: number, metadata: string) {
  return {
    id: event.id,
    event_id: event.id,
    name: event.event_name ?? null,
    event_name: event.event_name ?? null,
    user_id: event.user_id ?? null,
    convo_id: event.convo_id ?? null,
    started_at: prodStartedAt,
    // Imported cloud traces should surface as "just added" in Workshop's run
    // list, while the original production timing stays in metadata and spans.
    last_updated_at: Date.now(),
    metadata,
  };
}

function persistImport(run: ReturnType<typeof runRow>, spanRows: SpanInsertRow[]): void {
  getDrizzleDb().transaction((tx) => {
    tx.delete(schema.spans).where(eq(schema.spans.run_id, run.id)).run();
    tx.insert(schema.runs)
      .values(run)
      .onConflictDoUpdate({ target: schema.runs.id, set: run })
      .run();
    for (const span of spanRows) {
      tx.insert(schema.spans)
        .values(span)
        .onConflictDoUpdate({ target: schema.spans.id, set: span })
        .run();
    }
  });
}

export async function importCloudTrace(eventId: string, overrideKey?: string | null): Promise<ImportCloudTraceResult> {
  const event = await getQueryEvent(eventId, overrideKey);
  const spans = await getQueryTraceSpans(eventId, MAX_IMPORTED_TRACE_SPANS + 1, overrideKey);
  if (spans.length === 0) {
    throw new ImportCloudTraceRefused("no_spans", 0, 1, `Trace ${eventId} has no spans to import.`);
  }
  if (spans.length > MAX_IMPORTED_TRACE_SPANS) {
    throw new ImportCloudTraceRefused(
      "too_many_spans",
      spans.length,
      MAX_IMPORTED_TRACE_SPANS,
      `Trace has too many spans to import (${spans.length} > ${MAX_IMPORTED_TRACE_SPANS}).`,
    );
  }

  const runId = event.id;
  const wasPresent = !!getRunById(runId);
  const spanRows = spans.map((span) => spanRow(span, runId));
  const timing = productionTiming(spans);
  const { payloadBytes, metadata } = buildRunMetadata(event, timing, spanRows);
  const run = runRow(event, timing.prodStartedAt, metadata);

  persistImport(run, spanRows);

  return {
    status: wasPresent ? "updated" : "created",
    run_id: runId,
    event_id: event.id,
    event_name: event.event_name,
    span_count: spans.length,
    payload_bytes: payloadBytes,
    was_present: wasPresent,
  };
}

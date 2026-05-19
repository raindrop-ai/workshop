import type { NormalizedSpan } from "../normalized";

/**
 * What an adapter receives. Identical between live ingest (`parseOtlpRequest`)
 * and read-time re-normalization (replaying stored spans through the
 * dispatcher) — adapters don't care which path they ran from.
 */
export interface AdapterInput {
  /** OTLP span name (e.g. `"ai.streamText"`, `"ai.toolCall"`). */
  spanName: string;
  /** Flat attribute record. String / number / boolean values; nested JSON is left as a string. */
  attrs: Record<string, string | number | boolean>;
  /**
   * Already-inferred span type — saves adapters from re-deriving it.
   * `AGENT_ROOT` is the outer orchestration span (e.g. `ai.streamText`,
   * `ai.ToolLoopAgent.stream`) declared via `raindrop.span.kind = "agent_root"`.
   * Adapters currently bail on AGENT_ROOT / TRACE same as INTERNAL — those
   * spans are aggregators, the canonical per-call payloads live on their
   * LLM_GENERATION children.
   */
  spanType: "LLM_GENERATION" | "TOOL_CALL" | "AGENT_ROOT" | "TRACE" | "INTERNAL";
  /** The pre-coalesced raw payload, if any (used by adapters as a fallback). */
  inputPayload?: string;
  outputPayload?: string;
  /** `ai.operationId` if present — pre-extracted for convenience. */
  operationId?: string;
  /** `traceloop.span.kind` if present — pre-extracted for convenience. */
  traceloopKind?: string;
}

/** What an adapter produces when it recognizes a span. */
export interface AdapterMatch {
  /** The typed view consumers read from. */
  normalized: NormalizedSpan;
  /**
   * What to store as the canonical raw input string in the DB. The adapter
   * picks because it knows which attribute is the "real" payload for its
   * SDK (e.g. `ai.prompt.messages` for AI SDK, `ai.prompt` for claude-agent-sdk).
   * Optional — fall back to the dispatcher's pre-coalesced default if absent.
   */
  inputPayload?: string;
  outputPayload?: string;
}

/**
 * One SDK-shape adapter. Adapters are tried in registration order; the first
 * one that returns non-null wins. `null` means "not my shape, ask the next."
 */
export interface SpanAdapter {
  /** Stable identifier for debugging / telemetry. e.g. `"ai-sdk-llm"`. */
  readonly name: string;
  apply(input: AdapterInput): AdapterMatch | null;
}

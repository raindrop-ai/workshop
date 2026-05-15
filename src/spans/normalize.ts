/**
 * Single entry point for turning raw OTLP attributes into a typed,
 * SDK-agnostic view consumers can read without parsing strings.
 *
 *   ┌──────────────────────────────┐
 *   │ parseOtlpRequest (live ingest)│ ─┐
 *   └──────────────────────────────┘  │   ┌──────────────────┐
 *                                     ├──▶│ normalizeSpan()  │──▶ AdapterMatch
 *   ┌──────────────────────────────┐  │   └──────────────────┘
 *   │ getRunWithSpans (DB rows)    │ ─┘
 *   └──────────────────────────────┘
 *
 * Adapters are tried in the order listed below. First match wins. A no-match
 * default returns `{ kind: "other" }` so consumers always have *something*.
 *
 * Order matters: more-specific adapters go before less-specific ones.
 *   - `aiSdkLlmAdapter` matches structured prompts (JSON `ai.prompt(.messages)`)
 *   - `claudeAgentSdkLlmAdapter` is the raw-string fallback
 *   - `traceloopLlmAdapter` looks for the traceloop discriminator
 *   - tool adapters key off `spanType === "TOOL_CALL"`
 *   - TRACE wrappers intentionally normalize to `{ kind: "other" }`
 *
 * Adding a new SDK = add one file under `adapters/` and one entry here.
 */
import type { AdapterInput, AdapterMatch, SpanAdapter } from "./adapters/types";
import { emptyNormalized } from "./normalized";
import { aiSdkLlmAdapter, aiSdkToolAdapter } from "./adapters/ai-sdk";
import { claudeAgentSdkLlmAdapter } from "./adapters/claude-agent-sdk";
import { livekitLlmAdapter, livekitToolAdapter } from "./adapters/livekit";
import { traceloopLlmAdapter, traceloopToolAdapter } from "./adapters/traceloop";

const ADAPTERS: SpanAdapter[] = [
  aiSdkLlmAdapter,
  livekitLlmAdapter,
  traceloopLlmAdapter,
  claudeAgentSdkLlmAdapter,
  aiSdkToolAdapter,
  livekitToolAdapter,
  traceloopToolAdapter,
];

export function normalizeSpan(input: AdapterInput): AdapterMatch {
  for (const a of ADAPTERS) {
    const result = a.apply(input);
    if (result) return result;
  }
  return { normalized: emptyNormalized() };
}

/**
 * Build an `AdapterInput` from a stored DB row. Used at read time when we
 * want the typed view but the original OTLP request is long gone.
 */
export function adapterInputFromStoredSpan(row: {
  name: string;
  span_type: string | null;
  input_payload: string | null;
  output_payload: string | null;
  attributes: string | null;
}): AdapterInput {
  let attrs: Record<string, string | number> = {};
  if (row.attributes) {
    try { attrs = JSON.parse(row.attributes); } catch { /* leave empty */ }
  }
  const spanType =
    row.span_type === "LLM_GENERATION" ||
    row.span_type === "TOOL_CALL" ||
    row.span_type === "AGENT_ROOT" ||
    row.span_type === "TRACE"
      ? row.span_type
      : "INTERNAL";
  return {
    spanName: row.name,
    attrs,
    spanType,
    inputPayload: row.input_payload ?? undefined,
    outputPayload: row.output_payload ?? undefined,
    operationId: attrs["ai.operationId"] as string | undefined,
    traceloopKind: attrs["traceloop.span.kind"] as string | undefined,
  };
}

/**
 * Convenience: re-normalize a stored span row, returning just the typed view.
 * Used by API endpoints that augment span responses for the UI / replay.
 */
export function normalizeStoredSpan(row: {
  name: string;
  span_type: string | null;
  input_payload: string | null;
  output_payload: string | null;
  attributes: string | null;
}): AdapterMatch {
  return normalizeSpan(adapterInputFromStoredSpan(row));
}

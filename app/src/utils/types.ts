export interface Run {
  id: string;
  name: string | null;
  event_name: string | null;
  user_id: string | null;
  convo_id: string | null;
  started_at: number;
  last_updated_at: number;
  metadata: string | null;
  model?: string | null;
  finished?: number | null; // 1 if root span has OK/ERROR status
}

export interface ReplayMetadata {
  replay: {
    sourceRunId: string;
    mode: "magic" | "real_agent";
    model: string;
    overrides: {
      model?: boolean;
      systemPrompt?: boolean;
    };
    toolCallCount: number;
    iterations: number;
    matchStats: {
      exact: number;
      ordered: number;
      name_only: number;
      fallback: number;
    };
    error?: {
      code: string;
      message: string;
      status?: number;
      at?: number;
    };
  };
}

export function parseReplayMetadata(run: Run): ReplayMetadata | null {
  if (!run.metadata) return null;
  try {
    const parsed = JSON.parse(run.metadata);
    if (parsed?.replay?.sourceRunId) return parsed as ReplayMetadata;
  } catch {}
  return null;
}

/**
 * SDK-agnostic typed view of a span, populated by the server-side adapter
 * layer (`src/spans/`). Consumers should read from `Span.normalized` instead
 * of re-parsing `input_payload` / `output_payload` strings.
 *
 * Keep this in structural sync with `src/spans/normalized.ts` on the server.
 * The shape is small on purpose — extend only when a real consumer needs it.
 */
export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  raw?: unknown;
}

export interface NormalizedLLMSpan {
  kind: "llm";
  messages: NormalizedMessage[];
  userMessage: string;
  systemPrompt: string;
  model?: string;
  providerOptions?: Record<string, unknown>;
}

export interface NormalizedToolSpan {
  kind: "tool";
  name: string;
  args: unknown;
  result: unknown;
  resultIsError: boolean;
}

export interface NormalizedOtherSpan {
  kind: "other";
}

export type NormalizedSpan = NormalizedLLMSpan | NormalizedToolSpan | NormalizedOtherSpan;

export interface Span {
  id: string;
  run_id: string;
  parent_span_id: string | null;
  name: string;
  span_type: string | null;
  status: string;
  input_payload: string | null;
  output_payload: string | null;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  attributes: string | null;
  /**
   * SDK-agnostic typed view of this span's content. Populated by the server.
   * Always present on spans served via `/api/runs/detail/:id`. May be missing
   * on cached / saved-run rows captured before the adapter layer landed —
   * consumers should treat absence the same as `{ kind: "other" }`.
   */
  normalized?: NormalizedSpan;
}

export function getNormalizedTool(span: Span): NormalizedToolSpan | null {
  return span.normalized?.kind === "tool" ? span.normalized : null;
}

export interface LiveEvent {
  id: number;
  trace_id: string;
  span_id: string | null;
  type: string;
  content: string | null;
  timestamp: number;
  // REST returns the DB string (already JSON.stringify'd); the WebSocket
  // broadcast forwards req.body's parsed object. Consumers must handle both.
  metadata: string | Record<string, unknown> | null;
}

export interface SubAgent {
  root_span_id: string;
  name: string;
  span_ids: string[];
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  model: string | null;
  status: string;
  llm_count: number;
  tool_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

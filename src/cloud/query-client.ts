export const RAINDROP_QUERY_API_KEY_ENV = "RAINDROP_QUERY_API_KEY";
export const RAINDROP_QUERY_API_BASE_ENV = "RAINDROP_QUERY_API_BASE";

const DEFAULT_QUERY_API_BASE = "https://query.raindrop.ai";

export class QueryApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "QueryApiError";
  }
}

export interface QueryEvent {
  id: string;
  event_name: string;
  user_id: string | null;
  convo_id: string | null;
  timestamp: string;
  user_input: string | null;
  assistant_output: string | null;
  signals?: { id: string; name: string; score?: number }[];
  properties?: Record<string, unknown>;
}

export interface QuerySignal {
  id: string;
  type: string;
  name: string;
  description: string | null;
}

export interface QueryTraceSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  span_name: string;
  span_type: string;
  status: string;
  start_time_ns: number;
  end_time_ns: number;
  duration_ns: number;
  input: string | null;
  output: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  provider: string | null;
  attributes: Record<string, string | number>;
}

function resolveQueryApiKey(overrideKey?: string | null): string {
  const key = overrideKey?.trim() || process.env[RAINDROP_QUERY_API_KEY_ENV]?.trim();
  if (!key) {
    throw new QueryApiError(503, "Raindrop Query API key is not configured in Workshop Settings.");
  }
  return key;
}

function queryApiBase(): string {
  return (process.env[RAINDROP_QUERY_API_BASE_ENV]?.trim() || DEFAULT_QUERY_API_BASE).replace(/\/+$/, "");
}

/**
 * Build a Query API URL from a base and an absolute-style path while preserving
 * any path prefix on the base.
 *
 * `new URL("/v1/events/foo", "https://proxy.example/api/raindrop")` drops the
 * `/api/raindrop` prefix because the relative-resolution algorithm treats a
 * leading `/` as authority-rooted. Workshop callers always pass `/v1/...`
 * paths, so we join textually and let `URL` only parse the resulting absolute
 * string.
 */
function buildQueryApiUrl(path: string): URL {
  const base = queryApiBase();
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${base}${suffix}`);
}

function extractErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    const nested = error && typeof error === "object" ? (error as Record<string, unknown>).message : undefined;
    if (typeof nested === "string" && nested) return nested;
    if (typeof error === "string" && error) return error;
    if (error) return JSON.stringify(error);
  }
  return `Query API returned ${status}`;
}

export async function queryApiGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  overrideKey?: string | null,
): Promise<T> {
  const url = buildQueryApiUrl(path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${resolveQueryApiKey(overrideKey)}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new QueryApiError(res.status, extractErrorMessage(body, res.status));
  }
  return res.json() as Promise<T>;
}

export async function getQueryEvent(eventId: string, overrideKey?: string | null): Promise<QueryEvent> {
  const body = await queryApiGet<{ data: QueryEvent }>(
    `/v1/events/${encodeURIComponent(eventId)}`,
    undefined,
    overrideKey,
  );
  return body.data;
}

export async function getQueryTraceSpans(
  eventId: string,
  limit = 1000,
  overrideKey?: string | null,
): Promise<QueryTraceSpan[]> {
  const body = await queryApiGet<{ data: QueryTraceSpan[] }>(
    "/v1/traces",
    { event_id: eventId, limit },
    overrideKey,
  );
  return body.data;
}

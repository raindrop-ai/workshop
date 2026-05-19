import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Search, Loader2, AlertCircle, ChevronDown, X, HelpCircle } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { RunDetail } from "../components/RunDetail";
import { parseMessages } from "../components/MessageList";
import { Dots } from "../components/Icons";
import { SecretInput } from "../components/SecretInput";
import { C } from "../utils/colors";
import { ago } from "../utils/helpers";
import type { Run, Span, SubAgent } from "../utils/types";
import { Markdown } from "../components/Markdown";
import { tracePath } from "../utils/navigation";

const API_BASE = "https://query.raindrop.ai";

interface QueryEvent {
  id: string;
  event_name: string;
  user_id: string | null;
  convo_id: string | null;
  timestamp: string;
  user_input: string | null;
  assistant_output: string | null;
  signals?: { id: string; name: string; score?: number }[];
  properties?: Record<string, unknown>;
  relevance_score?: number;
}

interface Signal {
  id: string;
  type: string;
  name: string;
  description: string | null;
}

interface TraceSpan {
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

type SearchMode = "text" | "semantic" | "regex";

function getQueryKey(): string | null {
  return localStorage.getItem("rd_query_key");
}

async function apiFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const key = getQueryKey();
  if (!key) throw new Error("No Query API key configured. Add one in Settings.");
  const url = new URL(path, API_BASE);
  if (params) Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `API error ${res.status}`);
  }
  return res.json();
}

async function fetchSignals(): Promise<Signal[]> {
  const res = await apiFetch<{ data: Signal[] }>("/v1/signals", { limit: "100" });
  return res.data;
}

async function searchEvents(opts: {
  query: string; mode: SearchMode; signal?: string; limit?: number;
  cursor?: string; timestampGte?: string; timestampLt?: string;
}): Promise<{ data: QueryEvent[]; meta: { cursor: string | null; has_more: boolean } }> {
  const params: Record<string, string> = { query: opts.query, mode: opts.mode, limit: String(opts.limit ?? 25) };
  if (opts.signal) params.signal = opts.signal;
  if (opts.cursor) params.cursor = opts.cursor;
  if (opts.timestampGte) params["timestamp[gte]"] = opts.timestampGte;
  if (opts.timestampLt) params["timestamp[lt]"] = opts.timestampLt;
  return apiFetch("/v1/events/search", params);
}

async function listEvents(opts: {
  signal?: string; convoId?: string; limit?: number; cursor?: string;
  timestampGte?: string; timestampLt?: string; orderBy?: string;
}): Promise<{ data: QueryEvent[]; meta: { cursor: string | null; has_more: boolean } }> {
  const params: Record<string, string> = { limit: String(opts.limit ?? 25), order_by: opts.orderBy ?? "-timestamp" };
  if (opts.signal) params.signal = opts.signal;
  if (opts.convoId) params.convo_id = opts.convoId;
  if (opts.cursor) params.cursor = opts.cursor;
  if (opts.timestampGte) params["timestamp[gte]"] = opts.timestampGte;
  if (opts.timestampLt) params["timestamp[lt]"] = opts.timestampLt;
  return apiFetch("/v1/events", params);
}

async function fetchTraces(eventId: string): Promise<TraceSpan[]> {
  const res = await apiFetch<{ data: TraceSpan[] }>("/v1/traces", { event_id: eventId, limit: "500" });
  return res.data;
}

function mapTraceToSpans(traces: TraceSpan[], eventId: string): Span[] {
  return traces.map(t => {
    // For LLM spans, prefer ai.prompt from attributes (has system prompt + full message history)
    // over the flattened input field which only has the messages array
    let inputPayload = t.input;
    let outputPayload = t.output;
    if (t.span_type.includes("LLM")) {
      const aiPrompt = t.attributes["ai.prompt"] as string | undefined;
      if (aiPrompt) inputPayload = aiPrompt;
      const aiResponseText = t.attributes["ai.response.text"] as string | undefined;
      if (aiResponseText && !outputPayload) outputPayload = aiResponseText;
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
  }; });
}

/** Port of detectSubAgents from server — works on Span[] */
function detectSubAgents(spans: Span[]): SubAgent[] {
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
          if (s.input_tokens) totalIn += s.input_tokens;
          if (s.output_tokens) totalOut += s.output_tokens;
        }
        if (s.span_type === "TOOL_CALL" && s.id !== span.id) toolCount++;
      }
      for (const kid of children.get(id) ?? []) collect(kid.id);
    }
    collect(span.id);

    agents.push({
      root_span_id: span.id, name: span.name, span_ids: allSpanIds,
      start_time_ms: span.start_time_ms, end_time_ms: span.end_time_ms, duration_ms: span.duration_ms,
      model, status: span.status, llm_count: llmCount, tool_count: toolCount,
      total_input_tokens: totalIn, total_output_tokens: totalOut,
    });
  }
  return agents;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

const DATE_PRESETS = [
  { label: "24h", value: "1" },
  { label: "7d", value: "7" },
  { label: "30d", value: "30" },
] as const;

// Hover hints for the mode chips. Kept terse — the right-pane welcome panel
// has the long-form explanation; this is just for the in-context tooltip.
const MODE_HINTS: Record<SearchMode, string> = {
  text: "Substring match across user / assistant content. Fast, no ranking.",
  semantic: "Meaning-based, relevance-ranked. Limited to the last 14 days.",
  regex: "Regex over content (e.g. error|timeout, ^Failed.+).",
};

/**
 * Per-mode cap on preset range. Text/regex chunk cleanly across multiple
 * windows because results are filtered by content match. Semantic search
 * ranks by relevance within each request, so merging results across windows
 * doesn't produce a globally-best ranking — we cap it at the server's native
 * 14-day limit (i.e. anything ≤ 14d, which means 7d here) to keep results
 * meaningful.
 */
const MAX_PRESET_DAYS_BY_MODE: Record<SearchMode, number> = {
  text: Infinity,
  regex: Infinity,
  semantic: 14,
};

function isPresetAllowed(mode: SearchMode, presetDays: number): boolean {
  return presetDays <= MAX_PRESET_DAYS_BY_MODE[mode];
}

/**
 * The /v1/events/search endpoint caps each request at 14 days. We chunk wider
 * ranges into successive windows so the user can pick a 30d preset without
 * hitting BAD_REQUEST. We use 13 to stay safely under the server's strict
 * `> 14` check (clock skew between client and server can otherwise tip an
 * intended 14d range over the limit).
 *
 * This only applies to text/regex modes — semantic ranks results within a
 * single request, so chunking would yield a per-window pseudo-ranking rather
 * than a true global one. We disable >14d presets for semantic instead (see
 * MAX_PRESET_DAYS_BY_MODE).
 */
const MAX_SEARCH_WINDOW_DAYS = 13;

interface DateWindow { gte: string; lt: string; }

function buildSearchWindows(totalDays: number): DateWindow[] {
  const windows: DateWindow[] = [];
  let endMs = Date.now();
  let remaining = totalDays;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_SEARCH_WINDOW_DAYS);
    const startMs = endMs - chunk * 86400000;
    windows.push({ gte: new Date(startMs).toISOString(), lt: new Date(endMs).toISOString() });
    remaining -= chunk;
    endMs = startMs;
  }
  return windows;
}

export function SearchPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedEventId = routeRunId ? decodeURIComponent(routeRunId) : null;
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("text");
  const [selectedSignal, setSelectedSignal] = useState<string>("");
  const [dateRange, setDateRange] = useState("7");
  const [results, setResults] = useState<QueryEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  // Chunked-pagination state. `windows` is empty in browse mode (listEvents has
  // no 14d cap); for search mode it holds the time slices we'll page through
  // sequentially. `windowIdx` is the slice we're currently consuming.
  const [windows, setWindows] = useState<DateWindow[]>([]);
  const [windowIdx, setWindowIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards the on-mount browse below so it doesn't re-fire on every render.
  // Plain ref (not state) because we don't want to trigger a render on flip.
  const didInitialBrowse = useRef(false);
  const [hasQueryKey, setHasQueryKey] = useState(() => Boolean(getQueryKey()));

  useEffect(() => {
    const sync = () => setHasQueryKey(Boolean(getQueryKey()));
    const onStorage = (e: StorageEvent) => { if (e.key === "rd_query_key") sync(); };
    const onKeyChange = (e: Event) => {
      const detail = (e as CustomEvent<{ key?: string }>).detail;
      if (!detail || detail.key === "rd_query_key") sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("workshop:api-key-change", onKeyChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("workshop:api-key-change", onKeyChange);
    };
  }, []);

  useEffect(() => {
    if (!hasQueryKey) return;
    setSignalsLoading(true);
    fetchSignals().then(setSignals).catch(() => {}).finally(() => setSignalsLoading(false));
  }, [hasQueryKey]);

  /**
   * Fetch one page. Pass `cursor` to continue inside the current window, or
   * `windowIndex` to start fetching the first page of a different window.
   * Omit both for an initial search.
   */
  const doSearch = useCallback(async (opts: { append?: boolean; cursor?: string; windowIndex?: number } = {}) => {
    const isAppend = !!opts.append;
    if (isAppend) setLoadingMore(true); else setLoading(true);
    setError(null);
    if (!isAppend) setHasSearched(true);

    try {
      const trimmed = query.trim();
      const totalDays = Number(dateRange);

      // Build (or reuse) the per-search window list. Only search mode needs
      // chunking — `/v1/events` has no date-range cap, so we leave `windows`
      // empty and pass a single `gte` like before.
      const activeWindows: DateWindow[] = isAppend
        ? windows
        : trimmed
          ? buildSearchWindows(totalDays)
          : [];
      const activeIdx = opts.windowIndex ?? (isAppend ? windowIdx : 0);
      const useWindow = activeWindows.length > 0;
      const w = useWindow ? activeWindows[activeIdx] : undefined;

      const fetchOpts = {
        cursor: opts.cursor,
        timestampGte: w?.gte ?? daysAgo(totalDays),
        timestampLt: w?.lt,
      };

      const res = trimmed
        ? await searchEvents({ query: trimmed, mode, signal: selectedSignal || undefined, ...fetchOpts })
        : await listEvents({ signal: selectedSignal || undefined, ...fetchOpts });

      if (isAppend) setResults(prev => [...prev, ...res.data]);
      else setResults(res.data);

      let nextCursor = res.meta.cursor;
      let nextHasMore = res.meta.has_more;
      let nextIdx = activeIdx;

      // Current window is exhausted but we still have older windows to scan.
      // Surface this as `hasMore` so "load more" remains enabled; the next
      // click will fetch the first page of the next window.
      if (useWindow && !nextHasMore && activeIdx < activeWindows.length - 1) {
        nextIdx = activeIdx + 1;
        nextCursor = null;
        nextHasMore = true;
      }

      setCursor(nextCursor);
      setHasMore(nextHasMore);
      if (!isAppend) setWindows(activeWindows);
      setWindowIdx(nextIdx);
    } catch (e: any) {
      setError(e.message ?? "Search failed");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [query, mode, selectedSignal, dateRange, windows, windowIdx]);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); doSearch(); };

  // doSearch's identity changes on every keystroke (its deps include `query`),
  // so we keep a ref to the latest version and trigger runs through that. This
  // lets useEffect-based auto-browse and example-prefill flows depend on
  // primitives instead of refiring on every keystroke.
  const doSearchRef = useRef(doSearch);
  useEffect(() => { doSearchRef.current = doSearch; }, [doSearch]);

  // Auto-browse on mount so the left pane is never staring-into-the-void empty.
  // Most users land here to triage recent prod traffic — give them something to
  // click without forcing a "press Go to discover this works" friction step.
  useEffect(() => {
    if (didInitialBrowse.current) return;
    if (!hasQueryKey) return;
    didInitialBrowse.current = true;
    doSearchRef.current();
  }, [hasQueryKey]);

  // Run a one-shot search after a state-bump. setRunToken from the example
  // buttons; the effect fires after React commits the new query/mode/dateRange
  // state, so doSearchRef.current closes over the new values.
  const [runToken, setRunToken] = useState(0);
  useEffect(() => {
    if (runToken === 0) return;
    doSearchRef.current();
  }, [runToken]);

  const runExample = useCallback((nextQuery: string, nextMode: SearchMode) => {
    setQuery(nextQuery);
    setMode(nextMode);
    if (!isPresetAllowed(nextMode, Number(dateRange))) {
      const fallback = [...DATE_PRESETS].reverse().find(p => isPresetAllowed(nextMode, Number(p.value)));
      if (fallback) setDateRange(fallback.value);
    }
    setRunToken(t => t + 1);
    inputRef.current?.focus();
  }, [dateRange]);

  const handleLoadMore = useCallback(() => {
    if (cursor) {
      doSearch({ append: true, cursor });
    } else if (windowIdx < windows.length - 1) {
      doSearch({ append: true, windowIndex: windowIdx + 1 });
    }
  }, [cursor, windowIdx, windows, doSearch]);

  // Switching to a mode that doesn't support the current preset (e.g. picking
  // semantic while 30d is active) auto-falls-back to the largest still-allowed
  // preset so the user never sits in an invalid state.
  const handleModeChange = useCallback((nextMode: SearchMode) => {
    setMode(nextMode);
    if (!isPresetAllowed(nextMode, Number(dateRange))) {
      const fallback = [...DATE_PRESETS]
        .reverse()
        .find(p => isPresetAllowed(nextMode, Number(p.value)));
      if (fallback) setDateRange(fallback.value);
    }
  }, [dateRange]);

  const selectedEvent = useMemo(
    () => selectedEventId ? results.find((evt) => evt.id === selectedEventId) ?? null : null,
    [results, selectedEventId],
  );

  return (
    <div className="relative h-full overflow-hidden">
      <div
        className={`h-full flex transition-all duration-300 ${hasQueryKey ? "" : "pointer-events-none select-none blur-[3px] opacity-50"}`}
        aria-hidden={!hasQueryKey}
      >

      <div className="w-80 flex-shrink-0 flex flex-col" style={{ borderRight: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="p-3 space-y-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <form onSubmit={handleSubmit} className="flex gap-1.5">
            <div className="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded" style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${query ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}` }}>
              <Search className="h-3 w-3 shrink-0" style={{ color: C.fg0 }} />
              <input ref={inputRef} className="flex-1 min-w-0 bg-transparent text-[11px] font-mono outline-none" style={{ color: C.fg3 }}
                placeholder="Search events..." value={query} onChange={e => setQuery(e.target.value)} />
              {query && <button type="button" onClick={() => setQuery("")} className="shrink-0"><X className="h-2.5 w-2.5" style={{ color: C.fg0 }} /></button>}
            </div>
            <button type="submit" disabled={loading} className="px-2.5 py-1.5 rounded text-[10px] font-medium shrink-0"
              style={{ background: "#fff", color: "#000", opacity: loading ? 0.5 : 1 }}>
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Go"}
            </button>
          </form>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded overflow-hidden" style={{ background: "rgba(255,255,255,0.03)" }}>
              {(["text", "semantic", "regex"] as const).map(m => (
                <button key={m} className="px-2 py-0.5 text-[10px] font-mono transition-colors"
                  style={{ background: mode === m ? "rgba(255,255,255,0.06)" : "transparent", color: mode === m ? C.fg3 : C.fg0 }}
                  title={MODE_HINTS[m]}
                  onClick={() => handleModeChange(m)}>{m}</button>
              ))}
            </div>
            <div className="flex rounded overflow-hidden" style={{ background: "rgba(255,255,255,0.03)" }}>
              {DATE_PRESETS.map(p => {
                const allowed = isPresetAllowed(mode, Number(p.value));
                const tooltip = allowed
                  ? `Limit to the last ${p.label}`
                  : `${p.label} not supported in ${mode} mode (server caps semantic search at 14 days)`;
                return (
                  <button key={p.value}
                    className="px-2 py-0.5 text-[10px] font-mono transition-colors"
                    style={{
                      background: dateRange === p.value ? "rgba(255,255,255,0.06)" : "transparent",
                      color: dateRange === p.value ? C.fg3 : C.fg0,
                      opacity: allowed ? 1 : 0.35,
                      cursor: allowed ? "pointer" : "not-allowed",
                    }}
                    disabled={!allowed}
                    title={tooltip}
                    onClick={() => allowed && setDateRange(p.value)}>{p.label}</button>
                );
              })}
            </div>
          </div>
          <div className="relative">
            <select className="w-full appearance-none pl-2 pr-5 py-1 rounded text-[10px] font-mono outline-none cursor-pointer"
              style={{ background: "rgba(255,255,255,0.04)", color: C.fg2, border: `1px solid rgba(255,255,255,0.06)` }}
              value={selectedSignal} onChange={e => setSelectedSignal(e.target.value)} disabled={signalsLoading}>
              <option value="">All signals</option>
              {signals.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 pointer-events-none" style={{ color: C.fg0 }} />
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-0.5 sb">
          {error && (
            <div className="flex items-center gap-2 px-2 py-2 rounded" style={{ background: "rgba(235,20,20,0.06)" }}>
              <AlertCircle className="h-3 w-3 shrink-0" style={{ color: C.red }} />
              <span className="text-[10px]" style={{ color: C.red }}>{error}</span>
            </div>
          )}
          {loading && <div className="flex items-center justify-center py-12"><Loader2 className="h-4 w-4 animate-spin" style={{ color: C.fg0 }} /></div>}
          {!loading && !hasSearched && (
            <div className="text-center text-[11px] mt-8 px-2 leading-relaxed" style={{ color: C.fg0 }}>
              Press <span className="font-mono" style={{ color: C.fg2 }}>Go</span> to browse recent events,
              or type a query first.
            </div>
          )}
          {!loading && hasSearched && results.length === 0 && !error && (
            <div className="text-center text-[11px] mt-8 px-2 leading-relaxed" style={{ color: C.fg0 }}>
              {query.trim()
                ? <>No matches in this range. Try a wider date preset, a different mode, or clear the signal filter.</>
                : <>No events in this range. Events appear here once your agent ships traces with a Raindrop write key.</>}
            </div>
          )}
          {!loading && results.map(evt => (
            <ResultItem key={evt.id} event={evt} selected={selectedEventId === evt.id} onClick={() => navigate(tracePath("/search", evt.id))} />
          ))}
          {!loading && hasMore && (
            <div className="pt-1">
              <button onClick={handleLoadMore} disabled={loadingMore}
                className="w-full py-1.5 rounded text-[10px] font-mono" style={{ background: "rgba(255,255,255,0.03)", color: C.fg1 }}>
                {loadingMore ? <Loader2 className="h-3 w-3 animate-spin mx-auto" /> : "load more"}
              </button>
            </div>
          )}
        </div>
      </div>


      <div className="flex-1 min-w-0 overflow-hidden">
        {selectedEventId
          ? <RemoteRunDetail key={selectedEventId} eventId={selectedEventId} event={selectedEvent ?? undefined} />
          : hasQueryKey
            ? <SearchWelcome
                hasResults={results.length > 0}
                loading={loading}
                onExample={runExample}
              />
            : null
        }
      </div>
      </div>
      {!hasQueryKey && <SearchLockedOverlay />}
    </div>
  );
}

function SearchLockedOverlay() {
  const [pendingKey, setPendingKey] = useState("");
  const trimmed = pendingKey.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed) return;
    localStorage.setItem("rd_query_key", trimmed);
    window.dispatchEvent(new CustomEvent("workshop:api-key-change", { detail: { key: "rd_query_key" } }));
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 px-6">
      <div className="w-[640px] max-w-full px-10 py-11 text-center">
        <div
          className="mx-auto mb-6 flex h-20 w-20 items-center justify-center"
          style={{ color: C.fg2 }}
        >
          <Search className="h-11 w-11" strokeWidth={1.75} />
        </div>
        <h1
          className="text-center"
          style={{
            fontFamily: '"AlphaLyrae", sans-serif',
            fontSize: "36px",
            fontWeight: 500,
            lineHeight: 1.08,
            letterSpacing: "-0.025em",
            color: C.fg5,
          }}
        >
          Search Production Traces
        </h1>
        <p className="mx-auto mt-4 max-w-[520px] text-[17px] font-light leading-8" style={{ color: C.fg2 }}>
          Connect workshop to your Raindrop account to iterate on production traces locally.
        </p>
        <form className="mx-auto mt-8 max-w-[440px] text-left" onSubmit={handleSubmit}>
          <SecretInput
            label="Query API"
            placeholder="your-query-api-key"
            value={pendingKey}
            saved={false}
            onChange={setPendingKey}
            getKeyUrl="https://auth.raindrop.ai/org/api_keys"
          />
          <button
            type="submit"
            disabled={!trimmed}
            className="mt-3 w-full rounded py-2 text-[12px] font-medium"
            style={{ background: "#fff", color: "#000", opacity: trimmed ? 1 : 0.5 }}
          >
            Connect
          </button>
        </form>
      </div>
    </div>
  );
}

// Right pane when no event is picked: orient the user, explain the
// mode / date chips on the left, and offer a one-click sample per mode.
// While the left pane is still loading we render a slimmer "loading
// neighbours" hint to avoid a flash of welcome → trace.

function SearchWelcome({
  hasResults,
  loading,
  onExample,
}: {
  hasResults: boolean;
  loading: boolean;
  onExample: (q: string, mode: SearchMode) => void;
}) {
  return (
    <div className="h-full flex items-center justify-center px-8 py-10 overflow-auto sb">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2">
          <Search className="h-4 w-4" style={{ color: C.fg0 }} />
          <div className="text-sm font-medium" style={{ color: C.fg3 }}>
            Browse production traces
          </div>
          <div className="text-[11px] leading-relaxed" style={{ color: C.fg1 }}>
            {loading && !hasResults
              ? <>Loading recent events from <code className="font-mono" style={{ color: C.fg2 }}>query.raindrop.ai</code>…</>
              : hasResults
                ? <>Pick an event on the left to view its full trace, replay it, or save it for later.</>
                : <>Events from <code className="font-mono" style={{ color: C.fg2 }}>query.raindrop.ai</code>. Once your agent ships traces, they'll show up on the left — click any to view, replay, or save.</>}
          </div>
        </div>

        <ModeKey />

        <FilterKey />

        <ExampleQueries onExample={onExample} />
      </div>
    </div>
  );
}

function ModeKey() {
  const rows: { mode: SearchMode; gloss: string }[] = [
    { mode: "text", gloss: "Substring match. Fast, no ranking." },
    { mode: "semantic", gloss: "Meaning-based, ranked. Last 14 days only." },
    { mode: "regex", gloss: "Pattern, e.g. error|timeout." },
  ];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: C.fg0 }}>
        Search modes
      </div>
      <dl className="text-[11px] leading-snug">
        {rows.map(r => (
          <div key={r.mode} className="flex gap-2 py-0.5">
            <dt className="font-mono w-16 shrink-0" style={{ color: C.fg3 }}>{r.mode}</dt>
            <dd style={{ color: C.fg1 }}>{r.gloss}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function FilterKey() {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: C.fg0 }}>
        Filters
      </div>
      <dl className="text-[11px] leading-snug">
        <div className="flex gap-2 py-0.5">
          <dt className="font-mono w-16 shrink-0" style={{ color: C.fg3 }}>signal</dt>
          <dd style={{ color: C.fg1 }}>Tags emitted by your SDK (errors, drops, custom labels).</dd>
        </div>
        <div className="flex gap-2 py-0.5">
          <dt className="font-mono w-16 shrink-0" style={{ color: C.fg3 }}>range</dt>
          <dd style={{ color: C.fg1 }}>How far back to look. <span style={{ color: C.fg0 }}>30d</span> is text/regex only.</dd>
        </div>
      </dl>
    </div>
  );
}

function ExampleQueries({ onExample }: { onExample: (q: string, mode: SearchMode) => void }) {
  // Three buttons, one per mode, so clicking discovers the mode itself rather
  // than us having to teach all three through copy. Queries chosen to be
  // generic enough that most users with any traffic will see hits.
  const examples: { label: string; query: string; mode: SearchMode }[] = [
    { label: "errors", query: "error", mode: "text" },
    { label: "user got confused", query: "user got confused", mode: "semantic" },
    { label: "error|timeout", query: "error|timeout", mode: "regex" },
  ];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: C.fg0 }}>
        Try
      </div>
      <div className="flex flex-wrap gap-1.5">
        {examples.map(ex => (
          <button
            key={ex.label}
            onClick={() => onExample(ex.query, ex.mode)}
            className="text-[11px] font-mono px-2 py-1 rounded transition-colors"
            style={{
              background: "rgba(255,255,255,0.04)",
              color: C.fg2,
              border: `1px solid ${C.border}`,
            }}
            title={`Search "${ex.query}" in ${ex.mode} mode`}
          >
            <span style={{ color: C.fg0 }}>{ex.mode}:</span> {ex.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResultItem({ event, selected, onClick }: { event: QueryEvent; selected: boolean; onClick: () => void }) {
  const ts = new Date(event.timestamp);
  const timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
    ts.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

  return (
    <button className="w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150"
      style={{
        background: selected ? "rgba(255,255,255,0.08)" : "transparent",
        border: selected ? "1px solid rgba(255,255,255,0.15)" : "1px solid transparent",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "rgba(255,255,255,0.08)" : "transparent"; }}
      onClick={onClick}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium truncate" style={{ color: C.fg4 }}>{event.event_name}</span>
            {event.relevance_score != null && (
              <span className="text-[9px] font-mono px-1 shrink-0 rounded-full" style={{ background: "rgba(91,141,239,0.1)", color: C.accent }}>
                {(event.relevance_score * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {event.user_input && (
            <div className="text-[10px] truncate mt-0.5" style={{ color: C.fg1 }}>{event.user_input}</div>
          )}
          <div className="flex items-center gap-1.5 mt-1 overflow-hidden">
            {event.signals && event.signals.slice(0, 2).map(sig => (
              <span key={sig.id} className="text-[8px] font-mono px-1 py-px rounded-full shrink-0" style={{ background: "rgba(165,124,245,0.1)", color: C.purple }}>
                {sig.name}
              </span>
            ))}
            {event.signals && event.signals.length > 2 && (
              <span className="text-[8px] font-mono" style={{ color: C.fg0 }}>+{event.signals.length - 2}</span>
            )}
            <span className="text-[9px] flex-shrink-0 ml-auto" style={{ color: C.fg0 }}>{timeStr}</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function RemoteRunDetail({ eventId, event }: { eventId: string; event?: QueryEvent }) {
  const [spans, setSpans] = useState<Span[]>([]);
  const [traceLoading, setTraceLoading] = useState(true);
  const [traceError, setTraceError] = useState<string | null>(null);

  useEffect(() => {
    setTraceLoading(true);
    setTraceError(null);

    fetch(`/api/saved-runs/cache/${eventId}`)
      .then(r => r.ok ? r.json() : null)
      .then(async (cached) => {
        if (cached?.spans?.length) {
          setSpans(cached.spans);
          return;
        }
        const traces = await fetchTraces(eventId);
        const mapped = mapTraceToSpans(traces, eventId);
        setSpans(mapped);
        fetch(`/api/saved-runs/cache/${eventId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spans: mapped }),
        }).catch(() => {});
      })
      .catch(e => setTraceError(e.message ?? "Failed to load traces"))
      .finally(() => setTraceLoading(false));
  }, [eventId]);

  if (traceLoading) {
    return <div className="h-full flex items-center justify-center gap-2" style={{ color: C.fg1 }}>
      <Loader2 className="h-4 w-4 animate-spin" /> Loading trace...
    </div>;
  }

  if (traceError) {
    return <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-2">
        <AlertCircle className="mx-auto h-5 w-5" style={{ color: C.red }} />
        <div className="text-[11px]" style={{ color: C.red }}>{traceError}</div>
      </div>
    </div>;
  }

  if (spans.length === 0) {
    return <div className="h-full flex items-center justify-center">
      <div className="text-[11px]" style={{ color: C.fg0 }}>No trace data for this event</div>
    </div>;
  }

  // Build a Run object from the cloud event so RunDetail can render without DB
  const startMs = Math.min(...spans.map(s => s.start_time_ms));
  const endMs = Math.max(...spans.map(s => s.end_time_ms));
  const run: Run = {
    id: eventId, name: null as any, event_name: event?.event_name ?? eventId,
    user_id: event?.user_id ?? null, convo_id: event?.convo_id ?? null,
    started_at: startMs, last_updated_at: endMs,
    metadata: null as any, model: spans.find(s => s.model)?.model ?? null,
    finished: 1,
  } as Run;

  return <RunDetail
    runId={eventId}
    routeBase="/search"
    source="cloud"
    initialData={{ run, spans, liveEvents: [], subAgents: detectSubAgents(spans) }}
  />;
}

interface ConvoTurn {
  event: QueryEvent;
  spans: Span[];
}

type ConvoEvent =
  | { type: "turn_start"; turnIndex: number; event: QueryEvent; time: number }
  | { type: "user_msg"; content: string; time: number; turnIndex: number }
  | { type: "tool_group"; spans: Span[]; time: number; turnIndex: number }
  | { type: "llm_out"; content: string; time: number; turnIndex: number };

function buildRemoteConvoEvents(turns: ConvoTurn[]): ConvoEvent[] {
  const events: ConvoEvent[] = [];
  for (let i = 0; i < turns.length; i++) {
    const { event, spans } = turns[i];
    const time = new Date(event.timestamp).getTime();
    events.push({ type: "turn_start", turnIndex: i, event, time });

    // Extract user message from LLM input spans (same logic as ConvoDetail)
    const llmSpans = spans.filter(s => s.span_type?.includes("LLM")).sort((a, b) => a.start_time_ms - b.start_time_ms);

    let userMsg: string | null = null;
    const lastLLM = llmSpans[llmSpans.length - 1];
    if (lastLLM?.normalized?.kind === "llm" && lastLLM.normalized.userMessage) {
      userMsg = lastLLM.normalized.userMessage;
    } else if (lastLLM?.input_payload) {
      const messages = parseMessages(lastLLM.input_payload);
      if (messages) {
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        if (lastUser) userMsg = lastUser.content;
      } else {
        userMsg = lastLLM.input_payload;
      }
    }
    // Fallback to event's user_input
    if (!userMsg && event.user_input) userMsg = event.user_input;

    if (userMsg) events.push({ type: "user_msg", content: userMsg, time: time + 1, turnIndex: i });

    // Output: prefer LLM span output, fall back to event's assistant_output
    const outputSpan = llmSpans.find(s => s.output_payload);
    const output = outputSpan?.output_payload ?? event.assistant_output;
    if (output) events.push({ type: "llm_out", content: output, time: outputSpan?.end_time_ms ?? time + 2, turnIndex: i });
  }
  return events;
}

/**
 * Module-level cache so reopening the Convo tab on the same convo doesn't refetch.
 * Survives unmount (component-level state would be wiped by RunDetail's tab toggle).
 * Process-lifetime; cleared on full page reload.
 */
const cloudConvoCache = new Map<string, ConvoTurn[]>();

/**
 * Lazily fetch all turns of a cloud convo and render via RemoteConvoDetail.
 * Mounted only when the Convo tab is opened (RunDetail conditionally renders it),
 * so the cloud listEvents + per-event fetchTraces calls don't run for users who
 * never open the tab. Per-event spans are cached via /api/saved-runs/cache and
 * the assembled turn list is cached in `cloudConvoCache`.
 */
export function RemoteConvoLoader({ convoId, highlightEventId }: { convoId: string; highlightEventId: string }) {
  const [turns, setTurns] = useState<ConvoTurn[]>(() => cloudConvoCache.get(convoId) ?? []);
  const [loading, setLoading] = useState(() => !cloudConvoCache.has(convoId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cloudConvoCache.has(convoId)) {
      setTurns(cloudConvoCache.get(convoId)!);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await listEvents({ convoId, limit: 100, orderBy: "timestamp" });
        if (cancelled) return;
        const events = res.data;
        if (events.length === 0) {
          cloudConvoCache.set(convoId, []);
          setTurns([]);
          return;
        }

        const fetched = await Promise.all(events.map(async (event) => {
          const cached = await fetch(`/api/saved-runs/cache/${event.id}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);
          if (cached?.spans?.length) return { event, spans: cached.spans as Span[] };
          try {
            const traces = await fetchTraces(event.id);
            const spans = mapTraceToSpans(traces, event.id);
            fetch(`/api/saved-runs/cache/${event.id}`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ spans }),
            }).catch(() => {});
            return { event, spans };
          } catch {
            // Single-turn failure: keep the turn visible with no spans rather than failing the whole convo.
            return { event, spans: [] as Span[] };
          }
        }));
        if (!cancelled) {
          cloudConvoCache.set(convoId, fetched);
          setTurns(fetched);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load conversation");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [convoId]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-2">
          <AlertCircle className="mx-auto h-5 w-5" style={{ color: C.red }} />
          <div className="text-[11px]" style={{ color: C.red }}>{error}</div>
        </div>
      </div>
    );
  }

  return <RemoteConvoDetail turns={turns} loading={loading} highlightEventId={highlightEventId} />;
}

function RemoteConvoDetail({ turns, loading, highlightEventId }: { turns: ConvoTurn[]; loading: boolean; highlightEventId: string }) {
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to highlighted event once loaded
  useEffect(() => {
    if (!loading && turns.length > 0) {
      const el = document.getElementById(`convo-turn-${highlightEventId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [loading, turns, highlightEventId]);

  const events = useMemo(() => buildRemoteConvoEvents(turns), [turns]);

  if (loading) return <div className="flex items-center justify-center h-full gap-2" style={{ color: C.fg1 }}>Loading <Dots /></div>;
  if (turns.length === 0) return <div className="flex items-center justify-center h-full" style={{ color: C.fg1 }}>No runs found</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-4 py-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="text-[11px] font-mono inline-flex items-center gap-1.5" style={{ color: C.fg1 }}>
          <span>conversation</span>
          <span className="relative group inline-flex items-center">
            <HelpCircle size={13} style={{ color: C.fg0, cursor: "help" }} />
            <div className="absolute left-0 top-full mt-2 z-50 hidden group-hover:block">
              <div className="rounded-lg px-3 py-2 text-[11px] leading-relaxed whitespace-nowrap shadow-xl"
                style={{ background: C.elevated, border: `1px solid ${C.borderLight}`, color: C.fg3 }}>
                Conversation groups separate runs that share the same <span className="font-mono" style={{ color: C.fg4 }}>convo_id</span>
              </div>
            </div>
          </span>
          <span style={{ color: C.fg0 }}>&middot;</span>
          <span>{turns.length} run{turns.length !== 1 ? "s" : ""}</span>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto sb pb-24">
        {events.map((evt, i) => {
          const dimmed = hoveredTurn !== null && evt.turnIndex !== hoveredTurn;
          const isHighlightedTurn = turns[evt.turnIndex]?.event.id === highlightEventId;

          if (evt.type === "turn_start") {
            return (
              <div key={`td${i}`} id={`convo-turn-${evt.event.id}`}
                style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s" }}>
                <div className="flex items-center gap-3 px-4 pt-6 pb-2">
                  <div className="flex-1 h-px" style={{ background: isHighlightedTurn ? "rgba(91,141,239,0.3)" : "rgba(255,255,255,0.08)" }} />
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded" style={{
                    color: isHighlightedTurn ? C.accent : C.fg1,
                    background: isHighlightedTurn ? "rgba(91,141,239,0.1)" : "rgba(255,255,255,0.04)",
                  }}>
                    run {evt.turnIndex + 1}
                  </span>
                  <span className="text-[10px] cursor-default" style={{ color: C.fg0 }}
                    onMouseEnter={() => setHoveredTurn(evt.turnIndex)}
                    onMouseLeave={() => setHoveredTurn(null)}>{ago(new Date(evt.event.timestamp).getTime())}</span>
                  {evt.event.signals && evt.event.signals.length > 0 && evt.event.signals.map(sig => (
                    <span key={sig.id} className="text-[8px] font-mono px-1 py-px rounded-full"
                      style={{ background: "rgba(165,124,245,0.08)", color: C.purple }}>{sig.name}</span>
                  ))}
                  <div className="flex-1 h-px" style={{ background: isHighlightedTurn ? "rgba(91,141,239,0.3)" : "rgba(255,255,255,0.08)" }} />
                </div>
              </div>
            );
          }

          if (evt.type === "user_msg") {
            return (
              <div key={`um${i}`} style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s" }}>
                <div className="flex justify-end px-4 pt-5 pb-1">
                  <div className="max-w-[65%] px-3.5 py-2.5 rounded-2xl rounded-br-md" style={{ background: C.user }}>
                    <pre className="text-sm leading-relaxed font-sans whitespace-pre-wrap" style={{ color: C.fg3 }}>
                      {evt.content}
                    </pre>
                  </div>
                </div>
              </div>
            );
          }

          if (evt.type === "llm_out") {
            return (
              <div key={`lo${i}`} className="max-w-[85%] px-4 py-2"
                style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s" }}>
                <div className="text-message leading-relaxed" style={{ color: C.fg3 }}>
                  <Markdown>{evt.content}</Markdown>
                </div>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}

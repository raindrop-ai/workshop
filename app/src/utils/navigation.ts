export type TraceRouteBase = "/runs" | "/saved" | "/search";

/** Path to open a trace overview within a route namespace. */
export function tracePath(base: TraceRouteBase, runId: string): string {
  return `${base}/${encodeURIComponent(runId)}`;
}

/** Path to the span tree for a trace (no span selected). */
export function traceSpansPath(base: TraceRouteBase, runId: string): string {
  return `${tracePath(base, runId)}/spans`;
}

/** Path to a specific span within a trace. */
export function traceSpanPath(base: TraceRouteBase, runId: string, spanId: string): string {
  return `${tracePath(base, runId)}/span/${encodeURIComponent(spanId)}`;
}

/** Path to the conversation view for a trace. */
export function traceConvoPath(base: TraceRouteBase, runId: string): string {
  return `${tracePath(base, runId)}/convo`;
}

/** Path to open a run overview on the Runs page. */
export function runPath(runId: string): string {
  return tracePath("/runs", runId);
}

export type RunView = "overview" | "spans" | "span" | "convo";

/** Infer the active run sub-view from the current pathname. */
export function runViewFromPathname(pathname: string): RunView {
  if (pathname.endsWith("/convo")) return "convo";
  if (/\/span\/[^/]+$/.test(pathname)) return "span";
  if (pathname.endsWith("/spans")) return "spans";
  return "overview";
}

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { C } from "../utils/colors";
import { fmt, tryJson, detectProvider } from "../utils/helpers";
import type { Span } from "../utils/types";
import { Chevron } from "./Icons";
import { JsonView } from "./JsonView";
import { AnnotationChip, KIND_STYLES, SOURCE_GLYPH, annotationSourceLabel } from "./AnnotationChip";
import { InlineCreateForm } from "./TraceAnnotations";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { DeepLinkedText } from "../utils/deep-links";
import { sendWorkshopMessage } from "../hooks/use-workshop-ws";

function CollapsibleSection({ title, preview, data, maxExpand = 3 }: { title: string; preview: string; data: unknown; maxExpand?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="flex items-center gap-2 w-full text-left" onClick={() => setOpen(!open)}>
        <Chevron open={open} size={8} />
        <span className="text-[10px] uppercase tracking-wide font-medium" style={{ color: C.fg1 }}>{title}</span>
        {!open && <span className="text-[10px] font-mono truncate flex-1" style={{ color: C.fg0 }}>{preview}</span>}
      </button>
      {open && (
        <div className="mt-1 p-2 rounded" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${C.border}` }}>
          <JsonView data={data} maxExpand={maxExpand} />
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="text-[10px] font-mono px-1.5 py-0.5 rounded transition"
      style={{ color: copied ? C.green : C.fg0, background: "rgba(255,255,255,0.03)" }}
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

const TYPE_LABEL: Record<string, { color: string; label: string }> = {
  TRACE: { color: C.purple, label: "TRACE" },
  TOOL_CALL: { color: "#b08c5a", label: "TOOL" },
  LLM_GENERATION: { color: "#5a8ab0", label: "LLM" },
  INTERNAL: { color: C.fg0, label: "SPAN" },
};

function typeInfo(span: Span) {
  if (span.span_type === "TRACE") return TYPE_LABEL.TRACE;
  if (span.span_type === "TOOL_CALL") return TYPE_LABEL.TOOL_CALL;
  if (span.span_type?.includes("LLM")) return TYPE_LABEL.LLM_GENERATION;
  return TYPE_LABEL.INTERNAL;
}

function SpanRow({ span, depth, minTime, totalDur, selected, flashing, onClick, onContextMenu, annotations, freshIds, onClearFresh }: {
  span: Span; depth: number; minTime: number; totalDur: number;
  selected: boolean; flashing: boolean; onClick: () => void;
  onContextMenu?: (e: React.MouseEvent, span: Span) => void;
  annotations: Annotation[];
  freshIds: Set<string>;
  onClearFresh: (id: string) => void;
}) {
  const info = typeInfo(span);
  const color = info.color;
  const isErr = span.status === "ERROR";
  const leftPct = totalDur > 0 ? ((span.start_time_ms - minTime) / totalDur) * 100 : 0;
  const widthPct = totalDur > 0 ? Math.max((span.duration_ms / totalDur) * 100, 0.5) : 100;

  return (
    <div
      data-span-row={span.id}
      className="flex items-center cursor-pointer"
      style={{
        minHeight: 28,
        borderBottom: "1px solid rgba(255,255,255,0.03)",
        background: flashing ? "rgba(96,165,250,0.15)" : selected ? "rgba(255,255,255,0.04)" : isErr ? "rgba(204,102,102,0.04)" : "transparent",
        borderLeft: flashing ? `2px solid #60a5fa` : selected ? `2px solid ${C.fg2}` : isErr ? `2px solid ${C.red}` : "2px solid transparent",
        transition: "background 0.4s ease, border-left 0.4s ease",
      }}
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, span); } : undefined}
    >
      <div className="flex items-center gap-1.5 flex-shrink-0" style={{ width: 220, paddingLeft: depth * 14 + 8, minWidth: 220 }}>
        <span className="text-[10px] font-mono font-bold px-1 py-0.5 rounded" style={{ color: info.color, background: `${info.color}12` }}>
          {info.label}
        </span>
        <span className="text-[11px] font-mono truncate" style={{ color: isErr ? C.red : C.fg3 }} title={span.name}>
          {span.name}
        </span>
        {annotations.map((a) => (
          <AnnotationChip
            key={a.id}
            annotation={a}
            arriving={freshIds.has(a.id)}
            onArrivalEnd={() => onClearFresh(a.id)}
            title={a.note ?? undefined}
          />
        ))}
      </div>
      <div className="flex-1 relative mx-2" style={{ height: 10 }}>
        <div className="absolute rounded-sm"
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            top: 0,
            height: 10,
            backgroundColor: isErr ? C.red : color,
            boxShadow: isErr ? `0 0 8px ${C.red}80` : `0 0 8px ${color}80`,
            opacity: selected || flashing ? 1 : 0.88,
            minWidth: 2,
          }} />
      </div>
      <div className="flex-shrink-0 text-right pr-3" style={{ width: 55 }}>
        <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{fmt(span.duration_ms)}</span>
      </div>
    </div>
  );
}

function SpanDetail({ span }: { span: Span }) {
  const info = typeInfo(span);
  const isErr = span.status === "ERROR";

  return (
    <div className="p-4 space-y-3 h-full overflow-auto sb">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ color: info.color, background: `${info.color}15`, marginLeft: -6 }}>
            {info.label}
          </span>
          {isErr && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ color: C.red, background: "rgba(204,102,102,0.1)" }}>ERROR</span>}
          {(() => { const p = detectProvider(span.model, span.provider); return p ? <span className="text-[9px] font-mono font-medium px-1.5 py-0.5 rounded" style={{ color: C.fg1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" }}>{p.label}</span> : null; })()}
        </div>
        <div className="text-sm font-mono font-medium" style={{ color: C.fg4 }}>{span.name}</div>
      </div>

      {/* Error banner */}
      {isErr && span.output_payload && (
        <div className="rounded-lg p-2.5" style={{ background: "rgba(204,102,102,0.06)", border: "1px solid rgba(204,102,102,0.12)" }}>
          <div className="text-[9px] uppercase tracking-wide mb-1 font-medium" style={{ color: C.red }}>Error</div>
          <pre className="text-[11px] font-mono leading-relaxed" style={{ color: C.red }}>{tryJson(span.output_payload)}</pre>
        </div>
      )}

      {/* Meta */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono">
        <div style={{ color: C.fg0 }}>duration</div>
        <div style={{ color: C.fg2 }}>{fmt(span.duration_ms)}</div>
        {span.model && <><div style={{ color: C.fg0 }}>model</div><div style={{ color: C.fg2 }}>{span.model}</div></>}
        {span.input_tokens != null && <><div style={{ color: C.fg0 }}>input tokens</div><div style={{ color: C.fg2 }}>{span.input_tokens.toLocaleString()}</div></>}
        {span.output_tokens != null && <><div style={{ color: C.fg0 }}>output tokens</div><div style={{ color: C.fg2 }}>{span.output_tokens.toLocaleString()}</div></>}
        <div style={{ color: C.fg0 }}>status</div>
        <div style={{ color: isErr ? C.red : C.fg2 }}>{span.status}</div>
        <div style={{ color: C.fg0 }}>start</div>
        <div style={{ color: C.fg2 }}>{new Date(span.start_time_ms).toISOString().replace("T", " ").slice(0, 23)}</div>
        <div style={{ color: C.fg0 }}>end</div>
        <div style={{ color: C.fg2 }}>{span.end_time_ms ? new Date(span.end_time_ms).toISOString().replace("T", " ").slice(0, 23) : "—"}</div>
        <div style={{ color: C.fg0 }}>span id</div>
        <div style={{ color: C.fg0 }}>{span.id.slice(-12)}</div>
        {span.attributes && (() => { try { const a = JSON.parse(span.attributes); return a["ai.provider.baseURL"] ? <><div style={{ color: C.fg0 }}>base url</div><div style={{ color: C.fg0 }}>{a["ai.provider.baseURL"]}</div></> : null; } catch { return null; } })()}
      </div>

      {/* LLM Provider Options — collapsible */}
      {span.attributes && (() => {
        try {
          const attrs: unknown = JSON.parse(span.attributes);
          if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
          const configObj: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(attrs)) {
            if (k === "ai.provider.headers" ||
                k === "ai.request.thinking" || k === "ai.request.providerOptions" ||
                k.startsWith("ai.settings.") || k.startsWith("ai.request.headers.") ||
                (k.startsWith("gen_ai.request.") && k !== "gen_ai.request.model")) {
              const label = k.replace("gen_ai.request.", "").replace("ai.provider.", "").replace("ai.request.", "").replace("ai.settings.", "settings.");
              let parsed = v;
              if (typeof v === "string") { try { parsed = JSON.parse(v); } catch {} }
              // Unwrap providerOptions.{provider} — if it's a single-key object with a provider name, hoist its contents
              if (label === "providerOptions" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const parsedOptions = parsed as Record<string, unknown>;
                const keys = Object.keys(parsedOptions);
                if (keys.length === 1 && typeof parsedOptions[keys[0]] === "object") {
                  // e.g. { anthropic: { thinking: ..., cacheControl: ... } } → { thinking: ..., cacheControl: ... }
                  const inner = parsedOptions[keys[0]];
                  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
                    for (const [ik, iv] of Object.entries(inner)) {
                      configObj[ik] = iv;
                    }
                  }
                  continue;
                }
              }
              configObj[label] = parsed;
            }
          }
          if (Object.keys(configObj).length === 0) return null;
          const previewVal = (v: unknown): string => {
            if (v === null) return "null";
            if (v === true || v === false) return String(v);
            if (typeof v === "string") return v.length > 25 ? v.slice(0, 25) + "\u2026" : v;
            if (typeof v === "number") return String(v);
            if (Array.isArray(v)) return `[${v.length}]`;
            if (v && typeof v === "object") {
              const entries = Object.entries(v).slice(0, 3);
              const inner = entries.map(([ik, iv]) => `${ik}: ${typeof iv === "object" ? (iv === null ? "null" : Array.isArray(iv) ? `[${iv.length}]` : "{...}") : previewVal(iv)}`).join(", ");
              return entries.length < Object.keys(v).length ? `${inner}, \u2026` : inner;
            }
            return String(v);
          };
          const preview = Object.entries(configObj).map(([k, v]) => `${k}: ${previewVal(v)}`).join("  \u00B7  ");

          const providerName = (() => {
            const providerValue = Object.entries(attrs).find(([key]) => key === "ai.model.provider")?.[1];
            const p = typeof providerValue === "string" ? providerValue : undefined;
            if (!p) return "";
            const name = p.split(".")[0];
            return name.charAt(0).toUpperCase() + name.slice(1);
          })();
          const title = providerName ? `Provider Options (${providerName})` : "Provider Options";
          return <CollapsibleSection title={title} preview={preview} data={configObj} maxExpand={10} />;
        } catch { return null; }
      })()}

      {/* Input */}
      {span.input_payload && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-wide font-medium" style={{ color: C.fg1 }}>Input</div>
            <CopyButton text={tryJson(span.input_payload) ?? span.input_payload} />
          </div>
          <div className="p-2 rounded" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${C.border}` }}>
            <JsonView data={span.input_payload} />
          </div>
        </div>
      )}

      {/* Output */}
      {span.output_payload && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-wide font-medium" style={{ color: C.fg1 }}>Output</div>
            <CopyButton text={tryJson(span.output_payload) ?? span.output_payload} />
          </div>
          <div className="p-2 rounded" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${C.border}` }}>
            <JsonView data={span.output_payload} />
          </div>
        </div>
      )}
    </div>
  );
}

interface SpanTreeProps {
  spans: Span[];
  /** When set with `onSelectSpan`, selection is driven by the URL. */
  selectedSpanId?: string | null;
  onSelectSpan?: (spanId: string | null) => void;
  annotations?: Annotation[];
  freshIds?: Set<string>;
  onClearFresh?: (id: string) => void;
  onCreateAnnotation?: (input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: "user" | "claude-code" }) => Promise<Annotation | null>;
  onDeleteAnnotation?: (id: string) => Promise<void>;
}

interface ContextMenuState {
  spanId: string;
  x: number;
  y: number;
}

const EMPTY_ANNOTATIONS: Annotation[] = [];
const EMPTY_FRESH_IDS = new Set<string>();

export function SpanTree({
  spans,
  selectedSpanId,
  onSelectSpan,
  annotations = EMPTY_ANNOTATIONS,
  freshIds = EMPTY_FRESH_IDS,
  onClearFresh = () => {},
  onCreateAnnotation,
  onDeleteAnnotation,
}: SpanTreeProps) {
  const controlled = onSelectSpan !== undefined;
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const selectedId = controlled ? (selectedSpanId ?? null) : internalSelectedId;
  const setSelectedId = useCallback((id: string | null) => {
    if (controlled) onSelectSpan?.(id);
    else setInternalSelectedId(id);
  }, [controlled, onSelectSpan]);
  const autoSelectedRunRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [addingForSpan, setAddingForSpan] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const runId = spans[0]?.run_id ?? null;
  const reportedSelectedId = selectedId && spans.some((s) => s.id === selectedId) ? selectedId : null;

  useEffect(() => {
    if (controlled || !runId || autoSelectedRunRef.current === runId) return;
    autoSelectedRunRef.current = runId;
    setInternalSelectedId(spans[0]?.id ?? null);
  }, [controlled, runId, spans]);

  useEffect(() => {
    if (!runId) return;
    sendWorkshopMessage({ type: "ui_view", run_id: runId, span_id: reportedSelectedId });
  }, [runId, reportedSelectedId]);

  useEffect(() => {
    if (!runId) return;
    return () => sendWorkshopMessage({ type: "ui_view", run_id: runId, span_id: null });
  }, [runId]);

  // Deep-link receiver for uncontrolled trees (e.g. sub-agent drill-in).
  useEffect(() => {
    if (controlled) return;
    const spanIds = new Set(spans.map((s) => s.id));
    const handler = (ev: Event) => {
      const spanId = (ev as CustomEvent).detail?.spanId as string | undefined;
      if (!spanId || !spanIds.has(spanId)) return;
      setInternalSelectedId(spanId);
      setFlashId(spanId);
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-span-row="${spanId}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      window.setTimeout(() => setFlashId(null), 1500);
    };
    window.addEventListener("workshop:deep-link-span", handler);
    return () => window.removeEventListener("workshop:deep-link-span", handler);
  }, [controlled, spans]);

  useEffect(() => {
    if (!selectedSpanId) return;
    setFlashId(selectedSpanId);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-span-row="${selectedSpanId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const timeout = window.setTimeout(() => setFlashId(null), 1500);
    return () => window.clearTimeout(timeout);
  }, [selectedSpanId]);

  // Dismiss context menu on scroll / outside click / escape
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onEsc);
    };
  }, [contextMenu]);

  const annotationsBySpan = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (!a.span_id) continue;
      const arr = map.get(a.span_id) ?? [];
      arr.push(a);
      map.set(a.span_id, arr);
    }
    return map;
  }, [annotations]);

  const spanMap = new Map(spans.map(s => [s.id, s]));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const s of spans) {
    if (!s.parent_span_id || !spanMap.has(s.parent_span_id)) roots.push(s);
    else { const c = children.get(s.parent_span_id) ?? []; c.push(s); children.set(s.parent_span_id, c); }
  }

  const flat: { span: Span; depth: number }[] = [];
  function walk(span: Span, depth: number) {
    flat.push({ span, depth });
    for (const kid of children.get(span.id) ?? []) walk(kid, depth + 1);
  }
  for (const r of roots) walk(r, 0);

  const minTime = flat.length > 0 ? Math.min(...flat.map(f => f.span.start_time_ms)) : 0;
  const maxTime = flat.length > 0 ? Math.max(...flat.map(f => f.span.end_time_ms)) : 0;
  const totalDur = maxTime - minTime || 1;

  const selectedSpan = selectedId ? spanMap.get(selectedId) : null;

  if (flat.length === 0) return <div style={{ color: C.fg1 }}>No spans</div>;

  return (
    <div className="flex flex-col h-full rounded-lg" style={{ border: `1px solid ${C.border}` }}>
      <div className="flex flex-1 min-h-0">
        {/* Left: span list */}
        <div className="overflow-auto sb" style={{ flex: selectedSpan ? "0 0 50%" : "1 1 auto", borderRight: selectedSpan ? `1px solid ${C.border}` : "none" }}>
          {/* Header */}
          <div className="flex items-center px-2 py-1.5 sticky top-0 z-10" style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
            <div className="text-[9px] uppercase tracking-wider font-medium" style={{ color: C.fg0, width: 220 }}>Span</div>
            <div className="flex-1 text-[9px] uppercase tracking-wider font-medium" style={{ color: C.fg0 }}>Timeline</div>
            <div className="text-[9px] uppercase tracking-wider font-medium text-right pr-3" style={{ color: C.fg0, width: 55 }}>Dur</div>
          </div>
          {flat.map(({ span, depth }) => (
            <div key={span.id}>
              <SpanRow
                span={span} depth={depth}
                minTime={minTime} totalDur={totalDur}
                selected={span.id === selectedId}
                flashing={span.id === flashId}
                onClick={() => setSelectedId(span.id === selectedId ? null : span.id)}
                onContextMenu={onCreateAnnotation ? (e, s) => setContextMenu({ spanId: s.id, x: e.clientX, y: e.clientY }) : undefined}
                annotations={annotationsBySpan.get(span.id) ?? []}
                freshIds={freshIds}
                onClearFresh={onClearFresh}
              />
              {addingForSpan === span.id && onCreateAnnotation && (
                <div style={{ padding: "4px 10px 6px", paddingLeft: depth * 14 + 40 }}>
                  <InlineCreateForm
                    compact
                    onCancel={() => setAddingForSpan(null)}
                    onSubmit={async ({ kind, note }) => {
                      await onCreateAnnotation({ span_id: span.id, kind, note, source: "user" });
                      setAddingForSpan(null);
                    }}
                  />
                </div>
              )}
              {/* Expanded annotation cards for this span when selected */}
              {selectedId === span.id && (annotationsBySpan.get(span.id) ?? []).length > 0 && (
                <div style={{ padding: "4px 10px 6px", paddingLeft: depth * 14 + 40, display: "flex", flexDirection: "column", gap: 4 }}>
                  {(annotationsBySpan.get(span.id) ?? []).map((a) => {
                    const st = KIND_STYLES[a.kind];
                    return (
                      <div key={a.id} style={{ padding: "7px 9px", border: `1px solid ${st.border}`, background: `linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015)), ${st.bg}`, borderRadius: 8, display: "flex", alignItems: "flex-start", gap: 8 }}>
                        <div style={{ flex: 1, fontSize: 11, color: C.fg4, lineHeight: 1.45 }}>
                          <span style={{ color: C.fg0, fontSize: 10, marginRight: 6 }}>
                            {SOURCE_GLYPH[a.source]} {annotationSourceLabel(a.source)}
                          </span>
                          {a.note ? <DeepLinkedText text={a.note} /> : <em style={{ color: C.fg0 }}>(no note)</em>}
                        </div>
                        {onDeleteAnnotation && (
                          <button onClick={(e) => { e.stopPropagation(); onDeleteAnnotation(a.id); }} title="Delete" style={{ background: "transparent", border: 0, color: C.fg0, fontSize: 13, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>×</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
        {contextMenu && onCreateAnnotation && (
          <SpanContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onMarkKind={async (kind) => {
              await onCreateAnnotation({ span_id: contextMenu.spanId, kind, source: "user" });
              setContextMenu(null);
            }}
            onAddNote={() => {
              setAddingForSpan(contextMenu.spanId);
              setContextMenu(null);
            }}
          />
        )}

        {/* Right: detail */}
        {selectedSpan && (
          <div className="overflow-auto sb" style={{ flex: "0 0 50%", background: C.surface }}>
            <SpanDetail span={selectedSpan} />
          </div>
        )}
      </div>
    </div>
  );
}

function SpanContextMenu({ x, y, onClose, onMarkKind, onAddNote }: {
  x: number; y: number; onClose: () => void;
  onMarkKind: (kind: AnnotationKind) => void | Promise<void>;
  onAddNote: () => void;
}) {
  // Clamp within viewport
  const clampedX = Math.min(x, window.innerWidth - 230);
  const clampedY = Math.min(y, window.innerHeight - 180);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: clampedY, left: clampedX, zIndex: 50,
        minWidth: 210,
        padding: "4px 0",
        background: "#121214",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
        fontSize: 12,
        color: C.fg3,
      }}
    >
      <div style={{ padding: "4px 12px 2px", fontSize: 10, textTransform: "uppercase", color: C.fg0, letterSpacing: "0.04em" }}>
        Annotate span
      </div>
      {(["issue", "good", "note"] as AnnotationKind[]).map((kind) => {
        const s = KIND_STYLES[kind];
        return (
          <button
            key={kind}
            onClick={() => { if (kind === "note") onAddNote(); else onMarkKind(kind); }}
            style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              padding: "6px 12px", background: "transparent", border: 0, color: C.fg3,
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span style={{ width: 14, textAlign: "center", color: s.fg, fontWeight: 700 }}>{s.icon}</span>
            <span style={{ flex: 1 }}>{kind === "note" ? "Add note…" : `Mark as ${kind}`}</span>
          </button>
        );
      })}
    </div>
  );
}

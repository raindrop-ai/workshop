import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  runPath,
  runViewFromPathname,
  traceConvoPath,
  traceObserverDebugPath,
  tracePath,
  traceObserverPath,
  traceSpanPath,
  traceSpansPath,
  type TraceRouteBase,
} from "../utils/navigation";
import { animated, useSpring } from "@react-spring/web";
import NumberFlow from "@number-flow/react";
import { StickToBottom, useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import { Dots } from "./Icons";
import { Button } from "./Button";
import { ChatFlow } from "./ChatFlow";
import { SpanTree } from "./SpanTree";
import { ConvoDetail } from "./ConvoDetail";
import { RemoteConvoLoader } from "../pages/SearchPage";
import { RotateCcw, Bookmark, Pencil, ChevronDown, ArrowDown, ChevronRight, MessageCircle, SearchX } from "lucide-react";
import { LocalAgentSetupCTA, SetupReplayModal } from "./LocalAgentSetupCTA";
import { C } from "../utils/colors";
import { fmt, isActive, tryJson } from "../utils/helpers";
import { parseReplayMetadata } from "../utils/types";
import type { Run, Span, LiveEvent, SubAgent } from "../utils/types";
import { saveEvent, removeSavedEvent, updateSavedEvent, isEventSaved, getSavedEvents, SavePopover, type SavedAnnotationPreview, type SavedEvent } from "../pages/SavedPage";
import { parseMessages } from "./MessageList";
import { AnnotationCreatePopover, TraceAnnotations } from "./TraceAnnotations";
import { useAnnotations } from "../hooks/use-annotations";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { useAgentForEvent } from "../hooks/use-agents";
import { useSteering } from "../hooks/use-steering";
import { useWorkshopEvent } from "../hooks/use-workshop-ws";
import { getCostBreakdown, fmtCost } from "../utils/costs";
import type { RunSteeringData, SteeringEvent } from "../api/steering";
import { getRunDetail } from "../api/runs";

const TOKEN_NUMBER_FLOW_TIMING = {
  spinTiming: { duration: 450, easing: "ease-out" },
  transformTiming: { duration: 250, easing: "ease-out" },
} as const;

type SpansBroadcast = {
  runIds?: string[];
};

type LiveEventBroadcast = {
  traceId?: string;
  spanId?: string | null;
  type?: string;
  content?: string | null;
  timestamp?: number;
  metadata?: string | Record<string, unknown> | null;
};

function toLiveEvent(event: LiveEventBroadcast | undefined): LiveEvent | null {
  if (
    typeof event?.traceId !== "string" ||
    typeof event.type !== "string" ||
    typeof event.timestamp !== "number"
  ) {
    return null;
  }
  return {
    id: event.timestamp,
    trace_id: event.traceId,
    span_id: event.spanId ?? null,
    type: event.type,
    content: event.content ?? null,
    timestamp: event.timestamp,
    metadata: event.metadata ?? null,
  };
}

const DEFAULT_REPLAY_MODEL_FALLBACKS = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
] as const;

function buildReplayModelOptions(opts: {
  selectedModel?: string | null;
  runModel?: string | null;
  metadataModel?: string | null;
  anthropicModels?: string[];
}): string[] {
  const merged = [
    opts.selectedModel ?? null,
    opts.runModel ?? null,
    opts.metadataModel ?? null,
    ...(opts.anthropicModels ?? []),
    ...DEFAULT_REPLAY_MODEL_FALLBACKS,
  ];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const value of merged) {
    const next = value?.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    list.push(next);
  }
  return list;
}

/** Get token totals per model, only counting root LLM spans to avoid double-counting in ToolLoopAgent */
function getTokensByModel(spans: Span[]): Map<string, { inTok: number; outTok: number }> {
  const byModel = new Map<string, { inTok: number; outTok: number }>();
  // Find root LLM spans — those whose parent is NOT also an LLM span
  const llmIds = new Set(spans.filter(s => s.span_type?.includes("LLM")).map(s => s.id));
  for (const s of spans) {
    if (!s.model || !s.span_type?.includes("LLM")) continue;
    if (!(s.input_tokens || s.output_tokens)) continue;
    // Skip child LLM spans (doGenerate/doStream under a parent LLM)
    if (s.parent_span_id && llmIds.has(s.parent_span_id)) continue;
    const existing = byModel.get(s.model) ?? { inTok: 0, outTok: 0 };
    existing.inTok += s.input_tokens ?? 0;
    existing.outTok += s.output_tokens ?? 0;
    byModel.set(s.model, existing);
  }
  return byModel;
}

function ErrorMessage({ span }: { span: Span }) {
  let msg = span.output_payload;
  if (!msg && span.attributes) {
    try {
      const attrs = JSON.parse(span.attributes);
      msg = String(attrs["error.message"] ?? attrs["ai.response.error"] ?? attrs["exception.message"] ?? "");
    } catch {}
  }
  if (!msg) return null;
  return (
    <div className="text-[10px] font-mono mt-1 whitespace-pre-wrap break-words" style={{ color: "rgba(235,100,100,0.85)", maxHeight: 80, overflow: "hidden" }}>
      {String(msg).length > 200 ? String(msg).slice(0, 200) + "\u2026" : String(msg)}
    </div>
  );
}

function ErrorsTooltip({ spans }: { spans: Span[] }) {
  const [show, setShow] = useState(false);
  const errorSpans = useMemo(() => spans.filter(s => s.status === "ERROR"), [spans]);
  if (errorSpans.length === 0) return null;

  return (
    <span className="relative cursor-help"
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span style={{ color: C.red }}><NumberFlow value={errorSpans.length} /> error{errorSpans.length !== 1 ? "s" : ""}</span>
      {show && (
        <div className="absolute left-0 top-full mt-1 z-50 rounded-xl shadow-2xl overflow-hidden"
          style={{
            width: 380, maxHeight: 350,
            background: "rgba(20,8,8,0.85)",
            backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
            border: "1px solid rgba(235,20,20,0.25)",
            boxShadow: "0 8px 32px rgba(235,20,20,0.15), 0 0 0 1px rgba(235,20,20,0.1)",
          }}>
          <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: "1px solid rgba(235,20,20,0.15)" }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth={2.5} strokeLinecap="round">
              <circle cx={12} cy={12} r={10} /><line x1={12} y1={8} x2={12} y2={12} /><line x1={12} y1={16} x2={12.01} y2={16} />
            </svg>
            <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: C.red }}>
              {errorSpans.length} Error{errorSpans.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="overflow-auto" style={{ maxHeight: 300 }}>
            {errorSpans.map((s, idx) => (
              <div key={s.id} className="px-3 py-2" style={{ borderBottom: idx < errorSpans.length - 1 ? "1px solid rgba(235,20,20,0.1)" : "none" }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-mono font-bold px-1 py-0.5 rounded"
                    style={{ color: s.span_type === "TOOL_CALL" ? "#b08c5a" : s.span_type?.includes("LLM") ? "#5a8ab0" : C.fg0, background: "rgba(255,255,255,0.05)" }}>
                    {s.span_type === "TOOL_CALL" ? "TOOL" : s.span_type?.includes("LLM") ? "LLM" : "SPAN"}
                  </span>
                  <span className="text-[11px] font-mono truncate" style={{ color: C.red }}>{s.name}</span>
                  <span className="text-[9px] font-mono ml-auto flex-shrink-0" style={{ color: C.fg0 }}>{fmt(s.duration_ms)}</span>
                </div>
                <ErrorMessage span={s} />
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

const Dot = () => <span style={{ color: C.fg0, opacity: 0.35 }}>&middot;</span>;

function Badge({ label, copyValue }: { label: string; copyValue?: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetRef.current) window.clearTimeout(resetRef.current);
  }, []);

  if (!copyValue) {
    return (
      <span className="text-[9px] font-medium uppercase tracking-wide px-1 rounded" style={{ background: "rgba(255,255,255,0.09)", color: C.fg0, lineHeight: "16px" }}>
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="text-[9px] font-medium uppercase tracking-wide px-1 rounded transition-[color,background-color,transform] active:scale-[0.96]"
      style={{ background: copied ? "rgba(96,227,109,0.12)" : "rgba(255,255,255,0.09)", color: copied ? C.green : C.fg0, lineHeight: "16px" }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(copyValue).then(() => {
          setCopied(true);
          if (resetRef.current) window.clearTimeout(resetRef.current);
          resetRef.current = window.setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
    >
      {label}
    </button>
  );
}

function StatsLine({ stats, model, spans, active, startedAt }: {
  stats: { spans: number; tools: number; llms: number; errors: number; dur: number; agents?: number; inTokens?: number; outTokens?: number };
  model?: string | null;
  spans?: Span[];
  active?: boolean;
  startedAt?: number;
}) {
  const [showCost, setShowCost] = useState(false);
  const costRef = useRef<HTMLSpanElement>(null);
  const inTok = stats.inTokens ?? 0;
  const outTok = stats.outTokens ?? 0;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active]);

  const breakdown = useMemo(() => {
    if (!spans) return [];
    const byModel = getTokensByModel(spans);
    return [...byModel.entries()].map(([m, { inTok, outTok }]) => ({
      model: m, inTok, outTok,
      breakdown: getCostBreakdown(m, inTok, outTok),
    }));
  }, [spans]);

  const liveDur = active && startedAt ? now - startedAt : stats.dur;
  const durSec = Math.round(liveDur / 1000);
  const durMin = Math.floor(durSec / 60);
  const durRemSec = durSec % 60;

  return (
    <div className="flex items-center gap-1.5 text-[11px] flex-wrap" style={{ color: C.fg1 }}>
      {model && <><Badge label="model" copyValue={model} /><span>{model}</span><Dot /></>}
      {stats.tools > 0 && <><span><NumberFlow value={stats.tools} /> tool{stats.tools !== 1 ? "s" : ""}</span><Dot /></>}
      {(stats.agents ?? 0) > 0 && <><span><NumberFlow value={stats.agents!} /> sub-agent{stats.agents !== 1 ? "s" : ""}</span><Dot /></>}
      {stats.errors > 0 && spans && <><ErrorsTooltip spans={spans} /><Dot /></>}
      {stats.errors > 0 && !spans && <><span style={{ color: C.red }}><NumberFlow value={stats.errors} /> error{stats.errors !== 1 ? "s" : ""}</span><Dot /></>}
      <Badge label="duration" /><span>{durMin > 0 ? <><NumberFlow value={durMin} />m <NumberFlow value={durRemSec} />s</> : <><NumberFlow value={durSec} />s</>}</span>
      {(inTok > 0 || outTok > 0) && <><Dot /><Badge label="tokens" /><span><NumberFlow value={inTok} {...TOKEN_NUMBER_FLOW_TIMING} /> in / <NumberFlow value={outTok} {...TOKEN_NUMBER_FLOW_TIMING} /> out</span></>}
      {(() => {
        const totalCost = breakdown.reduce((sum, b) => sum + (b.breakdown?.totalCost ?? 0), 0);
        const cost = totalCost > 0 ? fmtCost(totalCost) : null;
        return cost && (
        <>
          <Dot />
          <span ref={costRef} className="relative cursor-help"
            onMouseEnter={() => setShowCost(true)} onMouseLeave={() => setShowCost(false)}>
            {cost}
            {showCost && breakdown.length > 0 && (
              <div className="absolute left-0 top-full mt-1 z-50 rounded-lg p-2.5 shadow-xl whitespace-nowrap"
                style={{ background: C.elevated, border: `1px solid ${C.borderLight}` }}>
                <div className="text-[9px] uppercase tracking-wide mb-2 font-medium" style={{ color: C.fg0 }}>Cost Breakdown</div>
                {breakdown.map(b => (
                  <div key={b.model} className="mb-2 last:mb-0">
                    <div className="text-[10px] font-medium mb-0.5" style={{ color: C.fg2 }}>{b.model}</div>
                    {b.breakdown && (
                      <div className="text-[9px] space-y-0.5" style={{ color: C.fg0 }}>
                        <div className="flex justify-between gap-4">
                          <span>{b.inTok.toLocaleString()} input @ ${b.breakdown.inRate}/M</span>
                          <span style={{ color: C.fg1 }}>{fmtCost(b.breakdown.inCost)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>{b.outTok.toLocaleString()} output @ ${b.breakdown.outRate}/M</span>
                          <span style={{ color: C.fg1 }}>{fmtCost(b.breakdown.outCost)}</span>
                        </div>
                        <div className="flex justify-between gap-4 pt-0.5" style={{ borderTop: `1px solid ${C.border}` }}>
                          <span style={{ color: C.fg1 }}>total</span>
                          <span style={{ color: C.fg2 }}>{fmtCost(b.breakdown.totalCost)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </span>
        </>
      );
      })()}
    </div>
  );
}

function MoreMenu({ runId, deleteRedirectPath = "/runs" }: { runId?: string; deleteRedirectPath?: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleDelete = async () => {
    if (!runId || !confirm("Delete this run and all its spans?")) return;
    await fetch(`/api/runs/${runId}`, { method: "DELETE" });
    setOpen(false);
    navigate(deleteRedirectPath, { replace: true });
  };

  return (
    <div ref={ref} className="relative">
      <button
        className="flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-white/10"
        style={{ color: C.fg1 }}
        onClick={() => setOpen(!open)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 rounded-lg overflow-hidden shadow-xl"
          style={{ background: "rgba(20,20,20,0.85)", backdropFilter: "blur(16px)", border: "1px solid rgba(255,255,255,0.12)", minWidth: 140 }}>
          <button
            className="w-full text-left px-3 py-2 text-[11px] transition-colors hover:bg-white/5"
            style={{ color: C.red }}
            onClick={handleDelete}
          >
            Delete run
          </button>
        </div>
      )}
    </div>
  );
}

/** Strip "replay:" prefix from event names for display */
function cleanTitle(title: string) {
  return title.replace(/^replay:/i, "").trim();
}

/** Inline editable text — click to edit, Enter to confirm, Escape to cancel */
function InlineEdit({ value, onConfirm, className, style, inputStyle }: {
  value: string; onConfirm: (v: string) => void;
  className?: string; style?: React.CSSProperties; inputStyle?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setDraft(value); inputRef.current?.focus(); inputRef.current?.select(); } }, [editing, value]);

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input ref={inputRef} className={`outline-none ${className ?? ""}`}
          style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, padding: "1px 6px", ...style, ...inputStyle }}
          value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { onConfirm(draft); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
          onBlur={() => setEditing(false)}
        />
      </span>
    );
  }
  return (
    <span className={`group/edit inline-flex items-center gap-1 cursor-pointer ${className ?? ""}`} style={style}
      onClick={() => setEditing(true)}>
      {value}
      <Pencil className="h-2.5 w-2.5 opacity-0 group-hover/edit:opacity-60 transition-opacity" />
    </span>
  );
}

function buildSavedEventFromRun({
  run,
  spans,
  source,
  folder,
  annotationPreview,
}: {
  run: Run;
  spans: Span[];
  source?: "local" | "cloud";
  folder?: string;
  annotationPreview?: SavedAnnotationPreview;
}): SavedEvent {
  let userInput: string | null = null;
  let assistantOutput: string | null = null;
  const llmSpans = spans.filter(s => s.span_type?.includes("LLM"));
  const best = llmSpans.reduce((b: Span | null, s) =>
    !b || (s.input_payload?.length ?? 0) > (b.input_payload?.length ?? 0) ? s : b, null);
  if (best?.normalized?.kind === "llm" && best.normalized.userMessage) {
    userInput = best.normalized.userMessage;
  } else if (best?.input_payload) {
    const msgs = parseMessages(best.input_payload);
    if (msgs) {
      const lastUser = [...msgs].reverse().find(m => m.role === "user");
      if (lastUser) userInput = lastUser.content;
    }
  }
  const outputSpan = llmSpans.find(s => s.output_payload);
  if (outputSpan?.output_payload) assistantOutput = outputSpan.output_payload;

  return {
    id: run.id,
    event_name: run.event_name ?? run.name ?? run.id.slice(0, 12),
    user_id: run.user_id,
    convo_id: run.convo_id,
    timestamp: new Date(run.started_at).toISOString(),
    user_input: userInput,
    assistant_output: assistantOutput,
    saved_at: Date.now(),
    source: source ?? "local",
    folder,
    properties: annotationPreview ? { annotation_preview: annotationPreview } : undefined,
  };
}

function annotationToSavedPreview(annotation: Annotation): SavedAnnotationPreview {
  return {
    id: annotation.id,
    kind: annotation.kind,
    note: annotation.note,
    source: annotation.source,
    span_id: annotation.span_id,
    created_at: annotation.created_at,
  };
}

function ViewHeader({
  title, model, active, stats, allSpans, startedAt, anthropicModels,
  run, source, isReplay, breadcrumb, fork, onAnnotateRun, deleteRedirectPath,
}: {
  title: string;
  model?: string | null;
  active: boolean;
  stats: { spans: number; tools: number; llms: number; errors: number; dur: number; agents?: number; inTokens?: number; outTokens?: number };
  allSpans?: Span[];
  startedAt?: number;
  anthropicModels?: string[];
  run?: Run;
  source?: "local" | "cloud";
  isReplay?: boolean;
  breadcrumb?: { onBack: () => void; parentName: string };
  fork?: {
    onFork: (userMessage?: string, mode?: "local", modelOverride?: string, contextOverrides?: Record<string, any>) => void;
    userMessage?: string;
  };
  onAnnotateRun?: (input: { kind: AnnotationKind; note: string }) => Promise<Annotation | null>;
  deleteRedirectPath?: string;
}) {
  const onBack = breadcrumb?.onBack;
  const parentName = breadcrumb?.parentName;
  const onFork = fork?.onFork;
  const userMessage = fork?.userMessage;
  const replayMeta = run ? parseReplayMetadata(run) : null;
  const traceModelFromMetadata = replayMeta?.replay?.model ?? null;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [forkMsg, setForkMsg] = useState(userMessage ?? "");
  const [forkModel, setForkModel] = useState(model ?? "");
  const [agentContext, setAgentContext] = useState<Record<string, string>>({});
  const [contextEdits, setContextEdits] = useState<Record<string, string>>({});
  // Live registry lookup — re-renders whenever the server broadcasts
  // `agents_updated` (e.g. after the user runs `raindrop setup` or hits
  // `/api/agents/refresh`).
  const { configured: agentConfigured } = useAgentForEvent(run?.event_name);
  const forkMode = "local" as const;
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [isSaved, setIsSaved] = useState(() => run ? isEventSaved(run.id) : false);
  const [currentFolder, setCurrentFolder] = useState<string | null>(() => {
    if (!run) return null;
    return getSavedEvents().find(e => e.id === run.id)?.folder ?? null;
  });
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const [annotationPopoverOpen, setAnnotationPopoverOpen] = useState(false);
  const annotationBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const refresh = () => {
      setIsSaved(run ? isEventSaved(run.id) : false);
      setCurrentFolder(run ? (getSavedEvents().find(e => e.id === run.id)?.folder ?? null) : null);
    };
    refresh();
    window.addEventListener("rd_saved_updated", refresh);
    return () => window.removeEventListener("rd_saved_updated", refresh);
  }, [run]);

  const handleSave = useCallback((folder?: string) => {
    if (!run) return;
    if (isSaved) {
      removeSavedEvent(run.id);
      setIsSaved(false);
      return;
    }
    saveEvent(buildSavedEventFromRun({ run, spans: allSpans ?? [], source, folder }));
    setIsSaved(true);
  }, [run, allSpans, isSaved, source]);

  const optionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setForkMsg(userMessage ?? ""); }, [userMessage]);
  useEffect(() => { setForkModel(model ?? ""); }, [model]);
  const forkModelOptions = useMemo(() => buildReplayModelOptions({
    selectedModel: forkModel,
    runModel: model,
    metadataModel: traceModelFromMetadata,
    anthropicModels,
  }), [forkModel, model, traceModelFromMetadata, anthropicModels]);

  useEffect(() => {
    if (!optionsOpen || !run?.id || !agentConfigured) return;
    fetch("/api/replay/context", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id, eventName: run.event_name }),
    }).then(r => r.json()).then(data => {
      if (data.context) {
        setAgentContext(data.context);
        setContextEdits(Object.fromEntries(Object.entries(data.context).map(([k, v]) => [k, String(v)])));
      }
    }).catch(() => {});
  }, [optionsOpen, run?.id, run?.event_name, agentConfigured]);

  useEffect(() => {
    if (!optionsOpen) return;
    const handler = (e: MouseEvent) => { if (!optionsRef.current?.contains(e.target as Node)) setOptionsOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [optionsOpen]);
  const displayTitle = cleanTitle(title);
  return (
    <div className="flex-shrink-0" style={{ padding: isReplay ? "8px 16px" : "10px 16px", borderBottom: `1px solid ${C.border}` }}>
      {parentName && onBack ? (
        <>
          <div><Button onClick={onBack}>&larr; Show Parent Agent</Button></div>
          <div className="mt-3 mb-1"><button className="text-[13px] font-medium cursor-pointer" style={{ color: C.fg1 }} onClick={onBack}>{parentName}</button></div>
          <div className="flex items-start ml-1">
            <svg className="flex-shrink-0" width="12" height="24" viewBox="0 0 12 24" style={{ marginRight: 6, marginTop: 2 }}>
              <path d="M 1 0 L 1 16 L 12 16" fill="none" stroke={C.fg0} strokeWidth="1" />
            </svg>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 style={{ fontSize: "18px", fontWeight: 600, color: C.fg5 }}>{displayTitle}</h2>
                {model && <span className="text-[10px] px-2 py-0.5 rounded font-mono" style={{ background: "rgba(255,255,255,0.04)", color: C.fg1 }}>{model}</span>}
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: active ? "rgba(102,170,187,0.1)" : "rgba(255,255,255,0.03)", color: active ? C.green : C.fg0 }}>
                  {active ? "Active" : "Done"}
                </span>
              </div>
              <StatsLine stats={stats} model={model} spans={allSpans} active={active} startedAt={startedAt} />
            </div>
          </div>
        </>
      ) : isReplay ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] font-medium" style={{ color: C.fg3 }}>{displayTitle}</span>
            {model && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: "rgba(255,255,255,0.04)", color: C.fg0 }}>{model}</span>}
            <span style={{ color: C.fg0, opacity: 0.4 }}>|</span>
            <StatsLine stats={stats} model={model} spans={allSpans} active={active} startedAt={startedAt} />
          </div>
          <MoreMenu runId={run?.id} deleteRedirectPath={deleteRedirectPath} />
        </div>
      ) : (
        <>
          <div className="flex items-center mb-1 justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${active ? "pulse-dot" : ""}`} style={{ background: active ? C.green : "rgba(255,255,255,0.18)" }} title={active ? "Active" : "Done"} />
              {onFork && !active ? (
                <InlineEdit value={displayTitle}
                  onConfirm={() => {}}
                  className="text-[15px] font-semibold truncate" style={{ color: C.fg4 }}
                  inputStyle={{ fontSize: 15, fontWeight: 600, color: C.fg4 }} />
              ) : (
                <h2 className="truncate" style={{ fontSize: "15px", fontWeight: 600, color: C.fg4 }}>{displayTitle}</h2>
              )}
            </div>
            {!active && (
              <div ref={optionsRef} className="relative flex items-center gap-1.5">
                {onAnnotateRun && (
                  <>
                    <button
                      ref={annotationBtnRef}
                      className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-md font-medium transition-colors hover:bg-white/10"
                      style={{ color: C.fg3, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                      onClick={() => {
                        setSavePopoverOpen(false);
                        setOptionsOpen(false);
                        setAnnotationPopoverOpen((open) => !open);
                      }}
                      title="Annotate run"
                    >
                      <Pencil className="h-3 w-3" />
                      Annotate
                    </button>
                    {annotationPopoverOpen && (
                      <AnnotationCreatePopover
                        anchorRef={annotationBtnRef}
                        onClose={() => setAnnotationPopoverOpen(false)}
                        onSubmit={onAnnotateRun}
                      />
                    )}
                  </>
                )}
                <button
                  className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-md font-medium transition-colors hover:bg-white/10"
                  style={{ color: C.fg3, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                  onClick={() => {
                    setSavePopoverOpen(false);
                    setAnnotationPopoverOpen(false);
                    setOptionsOpen(false);
                    window.dispatchEvent(new CustomEvent("workshop:open-message-pane", { detail: { runId: run?.id } }));
                  }}
                  title="Debug with Claude Code"
                >
                  <MessageCircle className="h-3 w-3" />
                  Debug
                </button>
                <button
                  ref={saveBtnRef}
                  className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-md font-medium transition-colors"
                  style={{ color: isSaved ? C.green : C.fg3, background: isSaved ? "rgba(96,227,109,0.08)" : "rgba(255,255,255,0.06)", border: `1px solid ${isSaved ? "rgba(96,227,109,0.2)" : "rgba(255,255,255,0.1)"}` }}
                  onClick={() => {
                    setAnnotationPopoverOpen(false);
                    if (!isSaved) handleSave();
                    setSavePopoverOpen(true);
                  }}
                  title={isSaved ? "Move folder or unsave" : "Save run"}
                >
                  <Bookmark className="h-3 w-3" style={isSaved ? { fill: C.green } : {}} />
                  {isSaved ? "Saved" : "Save"}
                </button>
                {savePopoverOpen && (
                  <SavePopover
                    anchorRef={saveBtnRef}
                    currentFolder={currentFolder}
                    onSave={(folder) => { if (run) updateSavedEvent(run.id, { folder }); setSavePopoverOpen(false); }}
                    onUnsave={() => { if (run) { removeSavedEvent(run.id); setIsSaved(false); setCurrentFolder(null); } setSavePopoverOpen(false); }}
                    onClose={() => setSavePopoverOpen(false)}
                  />
                )}
                {onFork && (() => {
                  return <>
                  {/* Split button: Replay | ▾ */}
                  <div className="flex items-stretch rounded-md overflow-hidden" style={{ border: `1px solid rgba(255,255,255,0.1)` }}>
                    <button
                      className="flex items-center gap-1.5 text-[11px] px-3 py-1 font-medium transition-colors hover:bg-white/10"
                      style={{
                        color: C.fg3,
                        background: "rgba(255,255,255,0.06)",
                      }}
                      onClick={() => {
                        if (agentConfigured) {
                          onFork(undefined, forkMode, forkModel || undefined);
                        } else {
                          setSetupModalOpen(true);
                        }
                      }}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Replay
                    </button>
                    <button
                      className="flex items-center justify-center px-1.5 transition-colors hover:bg-white/10"
                      style={{ color: C.fg1, background: "rgba(255,255,255,0.06)", borderLeft: "1px solid rgba(255,255,255,0.1)" }}
                      onClick={() => {
                        setAnnotationPopoverOpen(false);
                        setOptionsOpen(!optionsOpen);
                      }}
                      title="Replay with options"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <SetupReplayModal
                    open={setupModalOpen}
                    onClose={() => setSetupModalOpen(false)}
                    eventName={run?.event_name ?? undefined}
                  />
                  {optionsOpen && (
                    <div className="fixed z-[9999] rounded-lg p-3 shadow-xl space-y-3"
                      ref={(el) => {
                        if (!el || !optionsRef.current) return;
                        const btn = optionsRef.current.getBoundingClientRect();
                        el.style.top = `${btn.bottom + 4}px`;
                        el.style.right = `${window.innerWidth - btn.right}px`;
                      }}
                      style={{ background: "rgba(20,20,20,0.75)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05)", width: "min(384px, calc(100vw - 32px))" }}>
                      {/* Local Agent setup CTA when not configured */}
                      {!agentConfigured && (
                        <LocalAgentSetupCTA eventName={run?.event_name ?? undefined} />
                      )}
                      {/* Model */}
                      <div>
                        <div className="text-[10px] font-medium mb-1" style={{ color: C.fg0 }}>Model</div>
                        <select
                          className="w-full px-2 py-1.5 rounded text-[11px] font-mono outline-none appearance-none"
                          style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.1)" }}
                          value={forkModel}
                          onChange={e => setForkModel(e.target.value)}
                        >
                          <option value="" style={{ background: "#111", color: "#e8e8e8" }}>
                            {traceModelFromMetadata ? `Use trace default (${traceModelFromMetadata})` : "Use trace default model"}
                          </option>
                          {forkModelOptions.map((candidate) => (
                            <option key={candidate} value={candidate} style={{ background: "#111", color: "#e8e8e8" }}>
                              {candidate === traceModelFromMetadata ? `${candidate} (original trace model)` : candidate}
                            </option>
                          ))}
                        </select>
                      </div>
                      {/* User message */}
                      <div>
                        <div className="text-[10px] font-medium mb-1" style={{ color: C.fg0 }}>User message</div>
                        <textarea
                          className="w-full px-2 py-1.5 rounded text-[11px] font-mono outline-none resize-y"
                          style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: `1px solid rgba(255,255,255,0.1)`, minHeight: 60, maxHeight: 200 }}
                          value={forkMsg}
                          onChange={e => setForkMsg(e.target.value)}
                          placeholder="Enter user message..."
                        />
                      </div>
                      {/* Agent context (only when Local Agent + has context fields) */}
                      {Object.keys(contextEdits).length > 0 && (
                        <div>
                          <div className="text-[10px] font-medium mb-1.5" style={{ color: C.fg0 }}>Context</div>
                          <div className="space-y-1.5">
                            {Object.entries(contextEdits).map(([key, val]) => (
                              <div key={key} className="flex items-center gap-2">
                                <span className="text-[10px] font-mono flex-shrink-0 w-24 truncate" style={{ color: C.fg1 }} title={key}>{key}</span>
                                <input
                                  className="flex-1 min-w-0 px-2 py-1 rounded text-[10px] font-mono outline-none"
                                  style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.1)" }}
                                  value={val}
                                  onChange={e => setContextEdits(prev => ({ ...prev, [key]: e.target.value }))}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <button
                        className="w-full py-1.5 rounded text-[11px] font-medium transition-colors hover:brightness-110"
                        style={{
                          background: "rgba(255,255,255,0.08)",
                          color: C.fg4,
                          border: `1px solid rgba(255,255,255,0.1)`,
                        }}
                        onClick={() => {
                          if (!agentConfigured) {
                            setOptionsOpen(false);
                            setSetupModalOpen(true);
                            return;
                          }
                          setOptionsOpen(false);
                          const ctxOverrides = Object.keys(contextEdits).length > 0
                            ? Object.fromEntries(Object.entries(contextEdits).filter(([k, v]) => v !== String(agentContext[k] ?? "")))
                            : undefined;
                          onFork(forkMsg || undefined, forkMode, forkModel || undefined, Object.keys(ctxOverrides ?? {}).length ? ctxOverrides : undefined);
                        }}
                      >
                        Replay
                      </button>
                    </div>
                  )}
                </>;
                })()}
                <MoreMenu runId={run?.id} deleteRedirectPath={deleteRedirectPath} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] flex-wrap">
            <StatsLine stats={stats} model={model} spans={allSpans} active={active} startedAt={startedAt} />
            {run && (run.id || run.user_id || run.convo_id) && (
              <>
                <Dot />
                <span className="flex items-center gap-1.5" style={{ color: C.fg1 }}>
                  {run.user_id && <span className="inline-flex items-center gap-1" title={run.user_id}><Badge label="user" copyValue={run.user_id} />{run.user_id.length > 12 ? run.user_id.slice(0, 12) + "…" : run.user_id}</span>}
                  {run.convo_id && <span className="inline-flex items-center gap-1" title={run.convo_id}><Badge label="convo" copyValue={run.convo_id} />{run.convo_id.length > 12 ? run.convo_id.slice(0, 12) + "…" : run.convo_id}</span>}
                  <span className="inline-flex items-center gap-1" title={run.id}><Badge label="trace" copyValue={run.id} />{run.id.slice(0, 8)}</span>
                </span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EditReplayModal({ userMessage, model, runId, eventName, traceModelFromMetadata, anthropicModels, onReplay, onClose }: {
  userMessage: string; model?: string | null; runId: string; eventName?: string;
  traceModelFromMetadata?: string | null;
  anthropicModels?: string[];
  onReplay: (msg: string, mode: "local", mdl?: string, ctxOverrides?: Record<string, any>) => void;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState(userMessage);
  const [mdl, setMdl] = useState(model ?? "");
  const mode = "local" as const;
  // Live registry lookup; re-renders on `agents_updated` WS event, so the
  // modal reflects registry changes that happen while it's open (rare but
  // possible if the user runs the slash command in another window).
  const { configured: agentConfigured } = useAgentForEvent(eventName);
  const [agentContext, setAgentContext] = useState<Record<string, string>>({});
  const [contextEdits, setContextEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!agentConfigured) return;
    fetch("/api/replay/context", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, eventName }),
    }).then(r => r.json()).then(data => {
      if (data.context) {
        setAgentContext(data.context);
        setContextEdits(Object.fromEntries(Object.entries(data.context).map(([k, v]) => [k, String(v)])));
      }
    }).catch(() => {});
  }, [runId, eventName, agentConfigured]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
  const modalModelOptions = useMemo(() => buildReplayModelOptions({
    selectedModel: mdl,
    runModel: model,
    metadataModel: traceModelFromMetadata,
    anthropicModels,
  }), [mdl, model, traceModelFromMetadata, anthropicModels]);

  const handleReplay = () => {
    const ctxOverrides = mode === "local" && Object.keys(contextEdits).length > 0
      ? Object.fromEntries(Object.entries(contextEdits).filter(([k, v]) => v !== String(agentContext[k] ?? "")))
      : undefined;
    onClose();
    onReplay(msg, mode, mdl || undefined, Object.keys(ctxOverrides ?? {}).length ? ctxOverrides : undefined);
  };

  if (!agentConfigured) {
    return (
      <SetupReplayModal
        open={true}
        onClose={onClose}
        eventName={eventName}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-xl p-4 space-y-4 w-full max-w-md"
        style={{
          background: "rgba(20,20,20,0.85)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}>
        <div className="text-[13px] font-medium" style={{ color: C.fg3 }}>Edit &amp; Replay</div>

        {/* Model */}
        <div>
          <div className="text-[10px] font-medium mb-1" style={{ color: C.fg0 }}>Model</div>
          <select
            className="w-full px-2.5 py-2 rounded-lg text-[11px] font-mono outline-none appearance-none"
            style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.1)" }}
            value={mdl}
            onChange={e => setMdl(e.target.value)}
          >
            <option value="" style={{ background: "#111", color: "#e8e8e8" }}>
              {traceModelFromMetadata ? `Use trace default (${traceModelFromMetadata})` : "Use trace default model"}
            </option>
            {modalModelOptions.map((candidate) => (
              <option key={candidate} value={candidate} style={{ background: "#111", color: "#e8e8e8" }}>
                {candidate === traceModelFromMetadata ? `${candidate} (original trace model)` : candidate}
              </option>
            ))}
          </select>
        </div>

        {/* User message */}
        <div>
          <div className="text-[10px] font-medium mb-1" style={{ color: C.fg0 }}>User message</div>
          <textarea
            autoFocus
            className="w-full px-2.5 py-2 rounded-lg text-[11px] font-mono outline-none resize-y"
            style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.1)", minHeight: 100, maxHeight: 300 }}
            value={msg} onChange={e => setMsg(e.target.value)}
            placeholder="Enter user message..."
          />
        </div>

        {/* Agent context */}
        {Object.keys(contextEdits).length > 0 && (
          <div>
            <div className="text-[10px] font-medium mb-1.5" style={{ color: C.fg0 }}>Context</div>
            <div className="space-y-1.5">
              {Object.entries(contextEdits).map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-[10px] font-mono flex-shrink-0 w-28 truncate" style={{ color: C.fg1 }} title={key}>{key}</span>
                  <input
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg text-[10px] font-mono outline-none"
                    style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.1)" }}
                    value={val}
                    onChange={e => setContextEdits(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors hover:bg-white/10"
            style={{ color: C.fg1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 py-1.5 rounded-lg text-[11px] font-medium transition-colors hover:brightness-110"
            style={{
              color: C.fg4,
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.15)",
            }}
            onClick={handleReplay}
          >
            Replay
          </button>
        </div>
      </div>
    </div>
  );
}

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const spring = useSpring({
    transform: `translateX(-50%) translateY(${hovered ? -2 : 0}px) scale(${pressed ? 0.97 : hovered ? 1.04 : 1})`,
    background: hovered ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.09)",
    borderColor: hovered ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.14)",
    boxShadow: hovered ? "0 8px 24px rgba(0,0,0,0.26)" : "0 4px 14px rgba(0,0,0,0.18)",
    config: { tension: 360, friction: 24 },
  });
  if (isAtBottom) return null;
  return (
    <animated.button
      onClick={() => scrollToBottom()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      className="absolute bottom-2 left-1/2 z-10 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium backdrop-blur-sm"
      style={{
        ...spring,
        borderWidth: 1,
        borderStyle: "solid",
        color: C.fg4,
        willChange: "transform",
      }}
    >
      <ArrowDown size={12} />
      Scroll to bottom
    </animated.button>
  );
}

function TraceNotFound({ runId, backPath }: { runId: string; backPath: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/[0.04]">
          <SearchX className="h-5 w-5" style={{ color: C.fg1 }} />
        </div>
        <div className="text-[15px] font-medium" style={{ color: C.fg4, fontFamily: '"AlphaLyrae", sans-serif' }}>Trace not found</div>
        <div className="mt-2 text-sm leading-relaxed" style={{ color: C.fg1 }}>
          This trace is not available in the current workspace. It may have been deleted, cleared, or opened from a different project.
        </div>
        <code className="mt-3 block truncate rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-[11px]" style={{ color: C.fg0 }}>
          {runId}
        </code>
        <button
          type="button"
          className="mt-4 rounded-md border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.10] hover:text-white"
          onClick={() => navigate(backPath, { replace: true })}
        >
          Back to traces
        </button>
      </div>
    </div>
  );
}

function parseToolInput(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function eventActionLabel(action: SteeringEvent["action"]): string {
  switch (action) {
    case "system_prompt_update": return "Prompt update";
    case "stop": return "Stop";
    case "restart": return "Restart";
    case "continue": return "Continue";
    case "note": return "Note";
    case "nudge":
    default: return "Nudge";
  }
}

function formatUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return tryJson(value) ?? value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ObserverPayloadBlock({
  title,
  value,
  defaultOpen = true,
}: {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
}) {
  const text = formatUnknown(value);
  if (!text.trim()) return null;
  return (
    <details open={defaultOpen} className="rounded-md overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)", background: "rgba(0,0,0,0.16)" }}>
      <summary className="cursor-pointer px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide select-none" style={{ color: C.fg0, background: "rgba(255,255,255,0.035)" }}>
        {title}
      </summary>
      <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words p-2.5 overflow-auto" style={{ color: C.fg2, maxHeight: 520 }}>
        {text}
      </pre>
    </details>
  );
}

function ObserverMessagesBlock({ span }: { span: Span }) {
  if (span.normalized?.kind !== "llm" || span.normalized.messages.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.fg0 }}>Parsed messages fed to observer</div>
      {span.normalized.messages.map((message, index) => (
        <div key={`${span.id}-message-${index}`} className="rounded-md overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)", background: "rgba(0,0,0,0.16)" }}>
          <div className="px-2.5 py-1.5 text-[10px] font-mono" style={{ color: message.role === "system" ? C.green : message.role === "tool" ? "#d1a766" : C.fg1, background: "rgba(255,255,255,0.035)" }}>
            {message.role}
            {message.toolCallId ? ` · ${message.toolCallId}` : ""}
          </div>
          <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words p-2.5 overflow-auto" style={{ color: C.fg2, maxHeight: 420 }}>
            {message.content}
          </pre>
        </div>
      ))}
    </div>
  );
}

function compactText(value: unknown, limit = 1200): string {
  const raw = formatUnknown(value).trim();
  if (!raw) return "";
  const text = raw
    .replace(/^"|"$/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function spanAttributes(span: Span): Record<string, unknown> {
  if (!span.attributes) return {};
  try {
    const parsed = JSON.parse(span.attributes);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstAttribute(span: Span, keys: string[]): unknown {
  const attrs = spanAttributes(span);
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined && value !== null && compactText(value, 1).length > 0) return value;
  }
  return null;
}

function observerSpanInput(span: Span, limit = 1600): string {
  if (span.span_type === "TOOL_CALL") return toolArgsSummary(span);
  return compactText(
    span.input_payload ??
      firstAttribute(span, ["gen_ai.system", "ai.prompt", "ai.input", "input"]),
    limit,
  );
}

function observerSpanOutput(span: Span, limit = 1600): string {
  if (span.span_type === "TOOL_CALL") return "";
  return compactText(
    span.output_payload ??
      firstAttribute(span, ["ai.response.text", "gen_ai.response.text", "gen_ai.completion", "ai.output", "output"]),
    limit,
  );
}

function toolArgsSummary(span: Span): string {
  const tool = span.normalized?.kind === "tool" ? span.normalized : null;
  const args = tool?.args ?? span.input_payload ?? firstAttribute(span, ["ai.toolCall.args"]);
  if (!args) return "";
  if (typeof args === "object" && args !== null) {
    const obj = args as Record<string, unknown>;
    const preferred = ["description", "command", "query", "path", "file", "workdir"];
    const parts = preferred
      .filter((key) => obj[key] !== undefined && obj[key] !== null)
      .map((key) => `${key}: ${compactText(obj[key], 220)}`);
    if (parts.length > 0) return parts.join("\n");
  }
  return compactText(args, 700);
}

function ObserverCompactSpan({ span }: { span: Span }) {
  const isTool = span.span_type === "TOOL_CALL";
  const isLlm = Boolean(span.span_type?.includes("LLM"));
  const input = observerSpanInput(span);
  const output = observerSpanOutput(span);
  if (!isTool && !isLlm && !input && !output) return null;
  return (
    <div className="rounded-md p-3" style={{ background: "rgba(0,0,0,0.14)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ color: isTool ? "#d1a766" : C.green, background: "rgba(255,255,255,0.06)" }}>
          {isTool ? "Tool" : isLlm ? "Judge" : "Span"}
        </span>
        <span className="text-[11px] font-mono truncate" style={{ color: C.fg3 }}>{span.name}</span>
        {span.status === "ERROR" && <span className="text-[10px]" style={{ color: C.red }}>error</span>}
        <span className="ml-auto text-[10px] font-mono" style={{ color: C.fg0 }}>{fmt(span.duration_ms)}</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {input && (
          <div>
            <div className="text-[9px] uppercase tracking-wide mb-1" style={{ color: C.fg0 }}>{isTool ? "Args" : "Input"}</div>
            <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words rounded p-2" style={{ color: C.fg2, background: "rgba(0,0,0,0.18)", maxHeight: 260, overflow: "auto" }}>{input}</pre>
          </div>
        )}
        {output && (
          <div>
            <div className="text-[9px] uppercase tracking-wide mb-1" style={{ color: C.fg0 }}>Output</div>
            <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words rounded p-2" style={{ color: C.fg2, background: "rgba(0,0,0,0.18)", maxHeight: 260, overflow: "auto" }}>{output}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function payloadContainsCorrectiveAction(value: string | null | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower.includes("/api/steering/events") ||
    lower.includes('"action":"nudge"') ||
    lower.includes('"action": "nudge"') ||
    lower.includes('"action":"system_prompt_update"') ||
    lower.includes('"action": "system_prompt_update"') ||
    lower.includes('"action":"stop"') ||
    lower.includes('"action": "stop"') ||
    lower.includes('"action":"restart"') ||
    lower.includes('"action": "restart"')
  );
}

function observerActivationReason(spans: Span[]): string | null {
  const llm = spans.find((span) => span.span_type?.includes("LLM") && span.input_payload?.includes("Activation reason:"));
  if (!llm?.input_payload) return null;
  const match = llm.input_payload.match(/Activation reason:\s*([^\n"]+)/);
  return match?.[1]?.trim() ?? null;
}

function observerOutputSummary(spans: Span[]): string | null {
  const llm = [...spans].reverse().find((span) => span.span_type?.includes("LLM") && observerSpanOutput(span, 4000));
  if (!llm) return null;
  const text = observerSpanOutput(llm, 4000)
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 260 ? `${text.slice(0, 260)}...` : text;
}

function ObserverTraceCard({ observerRun, prominent = false, defaultOpen = false, raw = false }: { observerRun: Run; prominent?: boolean; defaultOpen?: boolean; raw?: boolean }) {
  const [detail, setDetail] = useState<{ spans: Span[]; liveEvents: LiveEvent[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getRunDetail(observerRun.id)
        .then((data) => { if (!cancelled) setDetail({ spans: data.spans, liveEvents: data.liveEvents ?? [] }); })
        .catch(() => { if (!cancelled) setDetail(null); });
    };
    load();
    const interval = window.setInterval(load, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [observerRun.id]);

  const spans = detail?.spans ?? [];
  const liveEvents = detail?.liveEvents ?? [];
  const toolCount = spans.filter((span) => span.span_type === "TOOL_CALL").length;
  const errorCount = spans.filter((span) => span.status === "ERROR").length;
  const activationReason = observerActivationReason(spans);
  const summary = observerOutputSummary(spans);
  const hasCorrectiveAction = spans.some((span) => payloadContainsCorrectiveAction(observerSpanInput(span)) || payloadContainsCorrectiveAction(observerSpanOutput(span)));

  return (
    <details open={defaultOpen} className="rounded-lg overflow-hidden" style={{ border: `1px solid ${prominent ? "rgba(102,170,187,0.28)" : C.border}`, background: prominent ? "rgba(102,170,187,0.045)" : "rgba(255,255,255,0.022)" }}>
      <summary className="cursor-pointer px-4 py-3 flex items-center justify-between gap-3 select-none" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide font-medium" style={{ color: prominent ? C.green : C.fg0 }}>
              {prominent ? "Observer action trace" : "Observer trace"}
            </span>
            {hasCorrectiveAction && <span className="text-[9px] uppercase tracking-wide px-1.5 rounded" style={{ color: C.green, background: "rgba(102,170,187,0.12)" }}>action</span>}
            {errorCount > 0 && <span className="text-[9px] uppercase tracking-wide px-1.5 rounded" style={{ color: C.red, background: "rgba(235,20,20,0.12)" }}>error</span>}
          </div>
          <div className="mt-1 text-[12px] truncate" style={{ color: C.fg3 }}>
            {activationReason ?? summary ?? `${observerRun.event_name ?? observerRun.name ?? "observer"} · ${observerRun.id.slice(0, 8)}`}
          </div>
        </div>
        <div className="text-[10px] font-mono flex-shrink-0" style={{ color: C.fg0 }}>
          {observerRun.finished ? "done" : "running"} · {toolCount} tools · {fmt(observerRun.last_updated_at - observerRun.started_at)}
        </div>
      </summary>
      <div className="p-3 space-y-2">
        {summary && (
          <div className="text-[11px] leading-relaxed rounded-md p-2.5" style={{ color: C.fg2, background: "rgba(0,0,0,0.14)", border: "1px solid rgba(255,255,255,0.05)" }}>
            {summary}
          </div>
        )}
        {spans.length === 0 && liveEvents.length === 0 ? (
          <div className="text-[11px]" style={{ color: C.fg0 }}>Waiting for observer reasoning...</div>
        ) : raw ? spans.map((span) => {
          const isTool = span.span_type === "TOOL_CALL";
          const normalizedTool = span.normalized?.kind === "tool" ? span.normalized : null;
          return (
            <div key={span.id} className="rounded-md p-3" style={{ background: "rgba(0,0,0,0.16)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ color: isTool ? "#d1a766" : C.green, background: "rgba(255,255,255,0.06)" }}>
                  {isTool ? "Tool" : span.span_type?.includes("LLM") ? "Judge" : "Span"}
                </span>
                <span className="text-[11px] font-mono truncate" style={{ color: C.fg3 }}>{span.name}</span>
                {span.status === "ERROR" && <span className="text-[10px]" style={{ color: C.red }}>error</span>}
                <span className="ml-auto text-[10px] font-mono" style={{ color: C.fg0 }}>{fmt(span.duration_ms)}</span>
              </div>
              <div className="space-y-2">
                <ObserverMessagesBlock span={span} />
                <ObserverPayloadBlock title={isTool ? "Tool input / command args" : "Raw input payload fed to observer"} value={span.input_payload} defaultOpen={true} />
                {normalizedTool && <ObserverPayloadBlock title="Parsed tool args" value={normalizedTool.args} defaultOpen={true} />}
                {normalizedTool && <ObserverPayloadBlock title="Parsed tool result / what observer read" value={normalizedTool.result} defaultOpen={true} />}
                <ObserverPayloadBlock title={isTool ? "Raw tool output / what observer read" : "Raw observer output payload"} value={span.output_payload} defaultOpen={true} />
                <ObserverPayloadBlock title="Raw span attributes" value={span.attributes} defaultOpen={false} />
              </div>
            </div>
          );
        }) : spans.map((span) => <ObserverCompactSpan key={span.id} span={span} />)}
        {liveEvents.length > 0 && (
          <div className="rounded-md p-3" style={{ background: "rgba(0,0,0,0.16)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: C.fg0 }}>Observer live events</div>
            <div className="space-y-2">
              {liveEvents.map((event) => (
                <ObserverPayloadBlock
                  key={event.id}
                  title={`${event.type}${event.span_id ? ` · ${event.span_id.slice(0, 8)}` : ""}`}
                  value={{ content: event.content, metadata: event.metadata, timestamp: event.timestamp }}
                  defaultOpen={true}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function ObserverPanel({
  run,
  spans,
  subAgents,
  steering,
  routeBase,
  onDiveIn,
}: {
  run: Run;
  spans: Span[];
  subAgents: SubAgent[];
  steering: RunSteeringData;
  routeBase?: TraceRouteBase;
  onDiveIn: (rootSpanId: string) => void;
}) {
  const navigate = useNavigate();
  const spansById = useMemo(() => new Map(spans.map((span) => [span.id, span])), [spans]);
  const eventsBySubagent = useMemo(() => {
    const map = new Map<string, SteeringEvent[]>();
    for (const event of steering.events) {
      const key = event.target_subagent_span_id ?? event.target_span_id ?? "__run__";
      map.set(key, [...(map.get(key) ?? []), event]);
    }
    return map;
  }, [steering.events]);

  const runLevelEvents = eventsBySubagent.get("__run__") ?? [];
  const observerRuns = steering.observerRuns.length > 0
    ? steering.observerRuns
    : steering.observerRunIds.map((id) => ({ id, name: null, event_name: "observer_agent_session" }) as Run);
  const observerRunsWithEvents = useMemo(() => {
    const ids = new Set(steering.events.map((event) => event.observer_run_id).filter(Boolean));
    return observerRuns.filter((observerRun) => ids.has(observerRun.id));
  }, [observerRuns, steering.events]);
  const passiveObserverCount = Math.max(0, observerRuns.length - observerRunsWithEvents.length);

  return (
    <div className="flex-1 min-h-0 overflow-auto sb" style={{ padding: 16 }}>
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="rounded-lg p-4" style={{ background: "rgba(255,255,255,0.035)", border: `1px solid ${C.border}` }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide font-medium mb-1" style={{ color: C.fg0 }}>Observer control plane</div>
              <div className="text-[14px] font-semibold" style={{ color: C.fg4 }}>
                {steering.events.length > 0 ? `${steering.events.length} corrective action${steering.events.length === 1 ? "" : "s"}` : "No observer action taken"}
              </div>
              <div className="text-[11px] mt-1 leading-relaxed" style={{ color: C.fg1 }}>
                Observer passes stay quiet unless they detect drift, repeated failures, or wrong-direction work. Corrective nudges and prompt updates appear here.
              </div>
            </div>
            <div className="text-right text-[10px] font-mono" style={{ color: C.fg0 }}>
              {passiveObserverCount > 0 ? `${passiveObserverCount} quiet pass${passiveObserverCount === 1 ? "" : "es"}` : `${observerRuns.length} observer pass${observerRuns.length === 1 ? "" : "es"}`}
            </div>
          </div>
          {observerRunsWithEvents.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {observerRunsWithEvents.map((observerRun) => (
                <button
                  key={observerRun.id}
                  className="rounded-md px-2.5 py-1 text-[11px] transition-colors hover:bg-white/10"
                  style={{ color: C.fg3, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}` }}
                  onClick={() => navigate(routeBase ? tracePath(routeBase, observerRun.id) : runPath(observerRun.id))}
                  title={observerRun.id}
                >
                  {observerRun.event_name ?? observerRun.name ?? "observer"} · {observerRun.id.slice(0, 8)}
                </button>
              ))}
            </div>
          )}
        </div>

        {steering.events.length === 0 && (
          <div className="rounded-lg p-8 text-center" style={{ color: C.fg1, border: `1px dashed ${C.border}` }}>
            No corrective observer action for this run.
            {observerRuns.length > 0 && (
              <div className="mt-2 text-[11px]" style={{ color: C.fg0 }}>
                {observerRuns.length} quiet observer pass{observerRuns.length === 1 ? "" : "es"} hidden.
              </div>
            )}
          </div>
        )}

        {observerRunsWithEvents.length > 0 && (
          <div className="space-y-3">
            {observerRunsWithEvents.map((observerRun) => (
              <ObserverTraceCard key={observerRun.id} observerRun={observerRun} prominent />
            ))}
          </div>
        )}

        {subAgents.length === 0 && steering.events.length > 0 && (
          <div className="rounded-lg p-8 text-center" style={{ color: C.fg1, border: `1px dashed ${C.border}` }}>
            No subagents detected in this run yet.
          </div>
        )}

        {subAgents.map((agent, index) => {
          const root = spansById.get(agent.root_span_id);
          const input = parseToolInput(root?.input_payload);
          const prompt = typeof input?.prompt === "string" ? input.prompt : null;
          const description = typeof input?.description === "string" ? input.description : agent.name;
          const events = [
            ...(eventsBySubagent.get(agent.root_span_id) ?? []),
            ...steering.events.filter((event) => event.target_span_id && agent.span_ids.includes(event.target_span_id) && event.target_subagent_span_id !== agent.root_span_id),
          ].sort((a, b) => a.created_at - b.created_at);
          const latestSpan = spans
            .filter((span) => agent.span_ids.includes(span.id) && span.id !== agent.root_span_id)
            .sort((a, b) => (b.start_time_ms ?? 0) - (a.start_time_ms ?? 0))[0];

          return (
            <div key={agent.root_span_id} className="rounded-lg overflow-hidden" style={{ background: "rgba(255,255,255,0.025)", border: `1px solid ${C.border}` }}>
              <div className="p-4" style={{ borderBottom: `1px solid ${C.border}` }}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wide font-medium" style={{ color: C.fg0 }}>Subagent {index + 1}</div>
                    <button className="mt-1 text-left text-[14px] font-semibold hover:underline" style={{ color: C.fg4 }} onClick={() => onDiveIn(agent.root_span_id)}>
                      {description}
                    </button>
                    {prompt && (
                      <div className="mt-2 text-[11px] leading-relaxed" style={{ color: C.fg1 }}>
                        {prompt}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right text-[10px] font-mono space-y-1" style={{ color: C.fg0 }}>
                    <div>{agent.status.toLowerCase()}</div>
                    <div>{agent.tool_count} tools · {agent.llm_count} llm</div>
                    {agent.duration_ms > 0 && <div>{fmt(agent.duration_ms)}</div>}
                  </div>
                </div>
                {latestSpan && (
                  <div className="mt-3 text-[10px] font-mono truncate" style={{ color: C.fg0 }}>
                    latest: {latestSpan.status === "ERROR" ? "error in " : ""}{latestSpan.name}
                  </div>
                )}
              </div>

              <div className="p-4 space-y-3">
                {events.length === 0 ? (
                  null
                ) : events.map((event) => (
                  <div key={event.id} className="rounded-md p-3" style={{ background: "rgba(102,170,187,0.055)", border: "1px solid rgba(102,170,187,0.18)" }}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.green }}>{eventActionLabel(event.action)}</span>
                      <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{event.status.replace(/_/g, " ")}</span>
                      {event.confidence !== null && <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{Math.round(event.confidence * 100)}%</span>}
                      <span className="ml-auto text-[10px] font-mono" style={{ color: C.fg0 }}>{new Date(event.created_at).toLocaleTimeString()}</span>
                    </div>
                    {event.message && <div className="text-[12px] leading-relaxed" style={{ color: C.fg3 }}>{event.message}</div>}
                    {event.reason && <div className="mt-1 text-[11px] leading-relaxed" style={{ color: C.fg1 }}>{event.reason}</div>}
                    {(event.before_prompt || event.after_prompt) && (
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {event.before_prompt && (
                          <div>
                            <div className="text-[9px] uppercase tracking-wide mb-1" style={{ color: C.fg0 }}>Before</div>
                            <pre className="text-[10px] whitespace-pre-wrap rounded p-2" style={{ color: C.fg1, background: "rgba(0,0,0,0.24)" }}>{event.before_prompt}</pre>
                          </div>
                        )}
                        {event.after_prompt && (
                          <div>
                            <div className="text-[9px] uppercase tracking-wide mb-1" style={{ color: C.fg0 }}>After</div>
                            <pre className="text-[10px] whitespace-pre-wrap rounded p-2" style={{ color: C.fg3, background: "rgba(0,0,0,0.24)" }}>{event.after_prompt}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {runLevelEvents.length > 0 && (
          <div className="rounded-lg p-4" style={{ border: `1px solid ${C.border}` }}>
            <div className="text-[10px] uppercase tracking-wide mb-3" style={{ color: C.fg0 }}>Run-level observer actions</div>
            <div className="space-y-2">
              {runLevelEvents.map((event) => (
                <div key={event.id} className="text-[12px] leading-relaxed" style={{ color: C.fg2 }}>
                  <span style={{ color: C.green }}>{eventActionLabel(event.action)}</span>
                  {event.message ? `: ${event.message}` : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ObserverDebugPanel({
  run,
  steering,
  routeBase,
}: {
  run: Run;
  steering: RunSteeringData;
  routeBase?: TraceRouteBase;
}) {
  const navigate = useNavigate();
  const observerRuns = steering.observerRuns.length > 0
    ? steering.observerRuns
    : steering.observerRunIds.map((id) => ({ id, name: null, event_name: "observer_agent_session", started_at: run.started_at, last_updated_at: run.last_updated_at }) as Run);
  const actionObserverIds = new Set(steering.events.map((event) => event.observer_run_id).filter(Boolean));
  const quietCount = observerRuns.filter((observerRun) => !actionObserverIds.has(observerRun.id)).length;

  return (
    <div className="flex-1 min-h-0 overflow-auto sb" style={{ padding: 16 }}>
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="rounded-lg p-4" style={{ background: "rgba(255,255,255,0.035)", border: `1px solid ${C.border}` }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide font-medium mb-1" style={{ color: C.fg0 }}>Observer debug</div>
              <div className="text-[14px] font-semibold" style={{ color: C.fg4 }}>
                {observerRuns.length} pass{observerRuns.length === 1 ? "" : "es"} linked
              </div>
              <div className="text-[11px] mt-1 leading-relaxed" style={{ color: C.fg1 }}>
                Debug view shows compact observer inputs, outputs, and tool calls. The main Observer tab only shows corrective actions.
              </div>
            </div>
            <div className="text-right text-[10px] font-mono space-y-1" style={{ color: C.fg0 }}>
              <div>{steering.events.length} action event{steering.events.length === 1 ? "" : "s"}</div>
              <div>{quietCount} quiet pass{quietCount === 1 ? "" : "es"}</div>
            </div>
          </div>
          {observerRuns.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {observerRuns.map((observerRun) => (
                <button
                  key={observerRun.id}
                  className="rounded-md px-2.5 py-1 text-[11px] transition-colors hover:bg-white/10"
                  style={{ color: actionObserverIds.has(observerRun.id) ? C.green : C.fg3, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}` }}
                  onClick={() => navigate(routeBase ? tracePath(routeBase, observerRun.id) : runPath(observerRun.id))}
                  title={observerRun.id}
                >
                  {actionObserverIds.has(observerRun.id) ? "action" : "quiet"} · {observerRun.id.slice(0, 8)}
                </button>
              ))}
            </div>
          )}
        </div>

        {observerRuns.length === 0 ? (
          <div className="rounded-lg p-8 text-center" style={{ color: C.fg1, border: `1px dashed ${C.border}` }}>
            No observer pass has been linked to this run yet.
          </div>
        ) : (
          <div className="space-y-3">
            {observerRuns.map((observerRun) => (
              <ObserverTraceCard
                key={observerRun.id}
                observerRun={observerRun}
                prominent={actionObserverIds.has(observerRun.id)}
                defaultOpen={true}
                raw={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function RunDetail({ runId, routeBase, initialData, isReplay, source, onForkStarted }: {
  runId: string;
  /** URL namespace that owns this detail view. Omit for embedded compare/replay panes. */
  routeBase?: TraceRouteBase;
  initialData?: { run: Run; spans: Span[]; liveEvents?: LiveEvent[]; subAgents?: SubAgent[] };
  isReplay?: boolean;
  source?: "local" | "cloud";
  onForkStarted?: (runId: string, userMessage?: string, mode?: "local", model?: string, contextOverrides?: Record<string, any>) => void;
}) {
  const [data, setData] = useState<{ run: Run; spans: Span[]; liveEvents: LiveEvent[]; subAgents: SubAgent[] } | null>(
    initialData ? { run: initialData.run, spans: initialData.spans, liveEvents: initialData.liveEvents ?? [], subAgents: initialData.subAgents ?? [] } : null
  );
  const dataRef = useRef(data);
  const navigate = useNavigate();
  const { spanId: routeSpanId } = useParams<{ spanId?: string }>();
  const { pathname } = useLocation();
  const usesRouteState = routeBase !== undefined;
  const runView = usesRouteState ? runViewFromPathname(pathname) : "overview";
  const tab: "chat" | "tree" | "convo" | "observer" | "observer-debug" =
    usesRouteState
      ? runView === "observer-debug" ? "observer-debug" : runView === "observer" ? "observer" : runView === "convo" ? "convo" : runView === "spans" || runView === "span" ? "tree" : "chat"
      : "chat";
  const routeSelectedSpanId = routeSpanId ? decodeURIComponent(routeSpanId) : null;
  const [localTab, setLocalTab] = useState<"chat" | "tree" | "convo" | "observer" | "observer-debug">("chat");
  const [localSelectedSpanId, setLocalSelectedSpanId] = useState<string | null>(null);
  const activeTab = usesRouteState ? tab : localTab;
  const selectedSpanId = usesRouteState ? routeSelectedSpanId : localSelectedSpanId;
  const [loading, setLoading] = useState(!initialData);
  const [notFound, setNotFound] = useState(false);
  const [agentTab, setAgentTab] = useState<"chat" | "tree">("chat");
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>(initialData?.liveEvents ?? []);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const annotationsApi = useAnnotations(runId);
  const steering = useSteering(runId);
  const autoSavedAnnotationIdsRef = useRef<Set<string>>(new Set());
  const stickToBottomContextRef = useRef<StickToBottomContext | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    const fetchModels = () => {
      const key = localStorage.getItem("rd_api_key") ?? "";
      // No key → no point hitting the endpoint (it would 400 and spam the
      // console). Re-runs when the user adds a key via the storage / custom
      // event listeners below.
      if (!key.trim()) return;
      fetch("/api/models/anthropic", { headers: { "x-rd-api-key": key } })
        .then(r => r.ok ? r.json() : null)
        .then((data) => {
          if (cancelled) return;
          if (Array.isArray(data?.models)) setAnthropicModels(data.models);
        })
        .catch(() => {});
    };
    fetchModels();
    const onStorage = (e: StorageEvent) => { if (e.key === "rd_api_key") fetchModels(); };
    const onKeyChange = () => fetchModels();
    window.addEventListener("storage", onStorage);
    window.addEventListener("workshop:api-key-change", onKeyChange);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("workshop:api-key-change", onKeyChange);
    };
  }, []);

  const goOverview = useCallback(() => {
    if (routeBase) navigate(tracePath(routeBase, runId));
    else setLocalTab("chat");
  }, [navigate, routeBase, runId]);
  const goSpans = useCallback(() => {
    if (routeBase) navigate(traceSpansPath(routeBase, runId));
    else setLocalTab("tree");
  }, [navigate, routeBase, runId]);
  const goConvo = useCallback(() => {
    if (routeBase) navigate(traceConvoPath(routeBase, runId));
    else setLocalTab("convo");
  }, [navigate, routeBase, runId]);
  const goObserver = useCallback(() => {
    if (routeBase) navigate(traceObserverPath(routeBase, runId));
    else setLocalTab("observer");
  }, [navigate, routeBase, runId]);
  const goObserverDebug = useCallback(() => {
    if (routeBase) navigate(traceObserverDebugPath(routeBase, runId));
    else setLocalTab("observer-debug");
  }, [navigate, routeBase, runId]);
  const selectSpan = useCallback(
    (spanId: string | null) => {
      if (routeBase) {
        if (spanId) navigate(traceSpanPath(routeBase, runId, spanId));
        else navigate(traceSpansPath(routeBase, runId));
        return;
      }
      setLocalTab("tree");
      setLocalSelectedSpanId(spanId);
    },
    [navigate, routeBase, runId],
  );

  // When another surface fires a span deep-link, open it in the span tree route.
  useEffect(() => {
    const handler = (ev: Event) => {
      const spanId = (ev as CustomEvent).detail?.spanId as string | undefined;
      if (!spanId) return;
      const spans = dataRef.current?.spans;
      if (!spans?.some((s) => s.id === spanId)) return;
      if (routeBase) navigate(traceSpanPath(routeBase, runId, spanId));
      else {
        setLocalTab("tree");
        setLocalSelectedSpanId(spanId);
      }
    };
    window.addEventListener("workshop:deep-link-span", handler);
    return () => window.removeEventListener("workshop:deep-link-span", handler);
  }, [navigate, routeBase, runId]);
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  const [editModal, setEditModal] = useState<{ userMessage: string } | null>(null);

  const fetchData = useCallback(async () => {
    if (initialData) return; // Skip DB fetch when data is provided directly
    try {
      const res = await fetch(`/api/runs/detail/${runId}`);
      if (res.status === 404) {
        setData(null);
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error(`Could not load run (${res.status})`);
      const j = await res.json();
      setData(j);
      setNotFound(false);
      if (j.liveEvents) setLiveEvents(j.liveEvents);
    } catch {
      setData(null);
      setNotFound(true);
    }
    finally { setLoading(false); }
  }, [runId, initialData]);

  useEffect(() => {
    if (initialData) return;
    setLoading(true);
    setNotFound(false);
    setData(null);
    setLiveEvents([]); setFocusedAgent(null); setAgentTab("chat"); setLocalTab("chat"); setLocalSelectedSpanId(null); setEditModal(null); fetchData();
  }, [runId, fetchData, initialData]);

  useEffect(() => {
    if (!routeBase || !selectedSpanId || !data?.spans.length) return;
    if (!data.spans.some((s) => s.id === selectedSpanId)) {
      navigate(traceSpansPath(routeBase, runId), { replace: true });
    }
  }, [data?.spans, navigate, routeBase, runId, selectedSpanId]);

  useEffect(() => {
    if (!routeBase || runView !== "convo" || !data?.run) return;
    if (!data.run.convo_id) navigate(tracePath(routeBase, runId), { replace: true });
  }, [data?.run, navigate, routeBase, runId, runView]);

  useLayoutEffect(() => {
    stickToBottomContextRef.current?.stopScroll();
  }, [runId]);

  useLayoutEffect(() => {
    const context = stickToBottomContextRef.current;
    context?.stopScroll();
    const resetScroll = () => {
      context?.stopScroll();
      const scrollElement = context?.scrollRef.current;
      if (scrollElement) scrollElement.scrollTop = 0;
    };
    resetScroll();
    const frame = requestAnimationFrame(resetScroll);
    const timeout = window.setTimeout(resetScroll, 0);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [data?.run.id]);

  useWorkshopEvent<SpansBroadcast | undefined>("spans", (data) => {
    if (initialData) return; // No WebSocket updates for pre-loaded data
    if (data?.runIds?.includes(runId)) fetchData();
  });

  useWorkshopEvent<LiveEventBroadcast | undefined>("live", (data) => {
    if (initialData || data?.traceId !== runId) return; // No WebSocket updates for pre-loaded data
    const event = toLiveEvent(data);
    if (event) setLiveEvents(p => [...p, event]);
  });

  // Extract last user message for fork pre-fill (must be before early returns — rules of hooks).
  // The server-side adapter layer already extracted this into `span.normalized.userMessage`
  // for every supported SDK shape, so we just pick the LLM span with the longest input
  // (still a useful "best candidate" heuristic for runs with many LLM calls) and read the
  // pre-extracted field. No JSON.parse, no SDK-specific branching.
  const lastUserMessage = useMemo(() => {
    if (!data?.spans) return "";
    const allLLMs = data.spans.filter((s: Span) => s.span_type?.includes("LLM"));
    const best = allLLMs.reduce((b: Span | null, s) =>
      !b || (s.input_payload?.length ?? 0) > (b.input_payload?.length ?? 0) ? s : b
    , null);
    if (best?.normalized?.kind === "llm" && best.normalized.userMessage) {
      return best.normalized.userMessage;
    }
    // Fallback for cached / saved rows that pre-date the adapter layer.
    return best?.input_payload ?? "";
  }, [data?.spans]);

  const saveAnnotationPreview = useCallback((annotation: Annotation) => {
    if (autoSavedAnnotationIdsRef.current.has(annotation.id)) return;
    const currentData = dataRef.current;
    if (!currentData?.run) return;
    autoSavedAnnotationIdsRef.current.add(annotation.id);

    const preview = annotationToSavedPreview(annotation);
    const existing = getSavedEvents().find(e => e.id === annotation.run_id);
    if (existing) {
      updateSavedEvent(annotation.run_id, {
        saved_at: Date.now(),
        properties: {
          ...(existing.properties ?? {}),
          annotation_preview: preview,
        },
      });
    } else {
      saveEvent(buildSavedEventFromRun({
        run: currentData.run,
        spans: currentData.spans,
        source,
        annotationPreview: preview,
      }));
    }
  }, [source]);

  const createAnnotationAndSave = useCallback(async (
    input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: "user" | "claude-code" | "codex" }
  ) => {
    const created = await annotationsApi.create({ ...input, source: input.source ?? "user" });
    if (created) saveAnnotationPreview(created);
    return created;
  }, [annotationsApi.create, saveAnnotationPreview]);

  useEffect(() => {
    for (const annotation of annotationsApi.annotations) {
      if (annotationsApi.freshIds.has(annotation.id)) saveAnnotationPreview(annotation);
    }
  }, [annotationsApi.annotations, annotationsApi.freshIds, saveAnnotationPreview]);

  if (loading) return <div className="flex items-center justify-center h-full gap-2" style={{ color: C.fg1 }}>Loading <Dots /></div>;
  if (notFound || !data?.run) return <TraceNotFound runId={runId} backPath={routeBase ?? "/runs"} />;

  const { run, spans, subAgents } = data;
  const replayMeta = parseReplayMetadata(run);

  // If focused on a sub-agent, show that sub-agent's view
  const agent = focusedAgent ? subAgents.find(a => a.root_span_id === focusedAgent) : null;

  if (agent) {
    const agentSpanSet = new Set(agent.span_ids);
    // Exclude the root tool call span — it's the parent invocation, not part of the sub-agent's work
    const agentSpans = spans.filter(s => agentSpanSet.has(s.id) && s.id !== agent.root_span_id);
    const agentTools = agentSpans.filter(s => s.span_type === "TOOL_CALL");
    const agentLLMs = agentSpans.filter(s => s.span_type?.includes("LLM"));
    const agentErrs = agentSpans.filter(s => s.status === "ERROR");

    const tabStyle = (k: string) => ({
      padding: "8px 12px", fontSize: "12px", fontWeight: 500, cursor: "pointer" as const,
      background: "none", border: "none",
      color: agentTab === k ? C.fg5 : C.fg0,
      borderBottom: agentTab === k ? `2px solid ${C.fg4}` : "2px solid transparent",
    });

    return (
      <div className="h-full flex flex-col">
        <ViewHeader
          title={agent.name}
          model={agent.model}
          active={isActive(run)}
          startedAt={agent.start_time_ms}
          anthropicModels={anthropicModels}
          stats={{
            spans: agentSpans.length, tools: agentTools.length, llms: agentLLMs.length, errors: agentErrs.length, dur: agent.duration_ms,
            inTokens: agent.total_input_tokens, outTokens: agent.total_output_tokens,
          }}
          allSpans={agentSpans}
          breadcrumb={{
            onBack: () => setFocusedAgent(null),
            parentName: run.event_name ?? run.name ?? run.id.slice(0, 12),
          }}
        />
        <div className="flex-shrink-0 flex" style={{ borderBottom: `1px solid ${C.border}`, paddingLeft: 16 }}>
          <button style={tabStyle("chat")} onClick={() => setAgentTab("chat")}>Overview</button>
          <button style={tabStyle("tree")} onClick={() => setAgentTab("tree")}>Span Tree</button>
        </div>
        {agentTab === "tree" ? (
          <div className="flex-1 relative min-h-0 overflow-auto sb" style={{ padding: 16 }}>
            <SpanTree spans={agentSpans} />
          </div>
        ) : (
          <StickToBottom className="flex-1 relative min-h-0" resize="smooth" initial={false} contextRef={stickToBottomContextRef}>
            <StickToBottom.Content className="sb">
              {agentTab === "chat" && <ChatFlow spans={agentSpans} liveEvents={[]} subAgents={[]} onDiveIn={setFocusedAgent} />}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </StickToBottom>
        )}
      </div>
    );
  }

  // Normal run view
  const active = isActive(run);
  const tools = spans.filter(s => s.span_type === "TOOL_CALL");
  const llms = spans.filter(s => s.span_type?.includes("LLM"));
  const errs = spans.filter(s => s.status === "ERROR");
  const dur = run.last_updated_at - run.started_at;
  const model = spans.find(s => s.model)?.model;

  const tabStyle = (k: string) => ({
    padding: "8px 12px", fontSize: "12px", fontWeight: 500, cursor: "pointer" as const,
    background: "none", border: "none",
    color: activeTab === k ? C.fg5 : C.fg0,
    borderBottom: activeTab === k ? `2px solid ${C.fg4}` : "2px solid transparent",
  });

  return (
    <div className="h-full flex flex-col">
      <ViewHeader
        title={run.event_name ?? run.name ?? run.id.slice(0, 12)}
        model={model}
        active={active}
        startedAt={run.started_at}
        anthropicModels={anthropicModels}
        stats={{
          spans: spans.length, tools: tools.length, llms: llms.length, errors: errs.length, dur,
          agents: subAgents.length,
          inTokens: [...getTokensByModel(spans).values()].reduce((s, v) => s + v.inTok, 0),
          outTokens: [...getTokensByModel(spans).values()].reduce((s, v) => s + v.outTok, 0),
        }}
        allSpans={spans}
        run={run}
        source={source}
        isReplay={isReplay}
        deleteRedirectPath={routeBase ?? "/runs"}
        onAnnotateRun={(input) => createAnnotationAndSave({ ...input, source: "user" })}
        fork={onForkStarted ? {
          onFork: (msg, mode, mdl, ctx) => onForkStarted(runId, msg, mode, mdl, ctx),
          userMessage: lastUserMessage,
        } : undefined}
      />
      <TraceAnnotations
        annotations={annotationsApi.annotations}
        freshIds={annotationsApi.freshIds}
        onClearFresh={annotationsApi.clearFresh}
        onDelete={annotationsApi.remove}
      />
      <div className="flex-shrink-0 flex" style={{ borderBottom: `1px solid ${C.border}`, paddingLeft: 16 }}>
        <button style={tabStyle("chat")} onClick={goOverview}>Overview</button>
        <button style={tabStyle("tree")} onClick={goSpans}>Span Tree</button>
        <button style={tabStyle("observer")} onClick={goObserver}>Observer</button>
        <button style={tabStyle("observer-debug")} onClick={goObserverDebug}>Observer Debug</button>
        {run.convo_id && (
          <button style={tabStyle("convo")} onClick={goConvo}>Convo</button>
        )}
      </div>
      {activeTab === "observer-debug" ? (
        <ObserverDebugPanel
          run={run}
          steering={steering}
          routeBase={routeBase}
        />
      ) : activeTab === "observer" ? (
        <ObserverPanel
          run={run}
          spans={spans}
          subAgents={subAgents}
          steering={steering}
          routeBase={routeBase}
          onDiveIn={setFocusedAgent}
        />
      ) : activeTab === "tree" ? (
        <div className="flex-1 relative min-h-0 overflow-auto sb" style={{ padding: 16 }}>
          <SpanTree
            spans={spans}
            selectedSpanId={selectedSpanId}
            onSelectSpan={selectSpan}
            annotations={annotationsApi.annotations}
            freshIds={annotationsApi.freshIds}
            onClearFresh={annotationsApi.clearFresh}
            onCreateAnnotation={createAnnotationAndSave}
            onDeleteAnnotation={annotationsApi.remove}
          />
        </div>
      ) : (
        <StickToBottom className="flex-1 relative min-h-0" resize="smooth" initial={false} contextRef={stickToBottomContextRef}>
          <StickToBottom.Content className="sb">
            {activeTab === "chat" && <ChatFlow spans={spans} liveEvents={liveEvents} subAgents={subAgents} onDiveIn={setFocusedAgent} isActive={active} lastUpdatedAt={run.last_updated_at} onEditMessage={onForkStarted && !active ? (msg) => setEditModal({ userMessage: msg }) : undefined} replayError={replayMeta?.replay?.error ?? null} />}
            {activeTab === "convo" && run.convo_id && (
              source === "cloud"
                ? <RemoteConvoLoader convoId={run.convo_id} highlightEventId={runId} />
                : <ConvoDetail convoId={run.convo_id} onOpenTurn={(id) => navigate(runPath(id))} />
            )}
          </StickToBottom.Content>
          <ScrollToBottomButton />
        </StickToBottom>
      )}
      {editModal && onForkStarted && (
        <EditReplayModal
          userMessage={editModal.userMessage}
          model={model}
          runId={runId}
          eventName={run.event_name ?? undefined}
          traceModelFromMetadata={parseReplayMetadata(run)?.replay?.model ?? null}
          anthropicModels={anthropicModels}
          onReplay={(msg, mode, mdl, ctx) => onForkStarted(runId, msg, mode, mdl, ctx)}
          onClose={() => setEditModal(null)}
        />
      )}
    </div>
  );
}

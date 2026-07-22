import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { C, spanColor } from "../utils/colors";
import { argsPreview, fmt, trunc, tryJson } from "../utils/helpers";
import type { LiveEvent, Span, SubAgent } from "../utils/types";
import { Button } from "./Button";
import { FlameTimeline } from "./FlameTimeline";
import { AlertCircle, Check, Chevron, Dots, Spinner } from "./Icons";
import { Markdown } from "./Markdown";
import { MessageList, messagesFromSpan } from "./MessageList";
import { ToolCallPill } from "./ToolCallPill";
import { extractLiveToolArgs } from "./chat-flow-live";
import { useSmoothText } from "../hooks/use-smooth-text";

type ToolGroupItem = { type: "tool"; span: Span } | { type: "sub_agent"; agent: SubAgent };
type LiveToolItem =
  | { type: "live_tool_start"; name: string; argsPreview: string | null; time: number }
  | { type: "live_tool_result"; name: string; time: number };

type ChatItem =
  | { type: "tool"; span: Span; time: number }
  | { type: "tool_group"; items: ToolGroupItem[]; time: number; liveTools?: LiveToolItem[] }
  | { type: "sub_agent"; agent: SubAgent; time: number }
  | { type: "user_msg"; content: string; parts?: string[]; time: number }
  | { type: "system_msg"; content: string; time: number; prevMessages?: { role: string; content: string }[] }
  | { type: "llm_out"; span: Span; time: number }
  | LiveToolItem
  | { type: "reasoning"; content: string; time: number }
  | { type: "text_delta"; content: string; time: number };

function isSyntheticPartialLlmSpan(span: Span): boolean {
  return span.id.startsWith("evt_") || span.span_type === "LLM";
}

function PreviousMessages({ messages }: { messages: { role: string; content: string }[] }) {
  const [expanded, setExpanded] = useState(false);
  const counts = ["assistant", "user", "tool"]
    .map(r => { const n = messages.filter(m => m.role === r).length; return n > 0 ? `${n} ${r}` : null; })
    .filter(Boolean).join(", ");

  return (
    <div>
      <div className="flex items-center gap-3 py-3">
        <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.18)" }} />
        <button
          className="flex flex-col items-center text-[11px] font-mono whitespace-pre leading-tight px-4 py-1 rounded-xl transition-all duration-200"
          style={{ color: C.fg2, background: "transparent" }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            "hide"
          ) : (
            <>
              <span className="text-[12px] font-medium normal-case leading-snug" style={{ color: C.fg2 }}>
                previous messages
              </span>
              <span className="mt-0.5 text-[10px] text-[--fg1] opacity-70 font-normal">
                {counts}
              </span>
            </>
          )}
        </button>
        <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.18)" }} />
      </div>
      {expanded && <div className="mt-1"><MessageList messages={messages} /></div>}
    </div>
  );
}

function SubAgentBlock({ agent, spans, onDiveIn }: { agent: SubAgent; spans: Span[]; onDiveIn?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const a = agent;

  const agentSpanSet = new Set(a.span_ids);
  const rootSpan = spans.find(s => s.id === a.root_span_id);
  const agentToolSpans = spans.filter(s => agentSpanSet.has(s.id) && s.span_type === "TOOL_CALL" && s.id !== a.root_span_id);
  // Find sub-agent LLM spans for input/output (agent.subagent or nested generateText)
  const agentLLMs = spans.filter(s => agentSpanSet.has(s.id) && s.span_type?.includes("LLM") && s.id !== a.root_span_id);
  const agentInput = agentLLMs.find(s => s.input_payload)?.input_payload ?? rootSpan?.input_payload;
  const agentOutput = agentLLMs.find(s => s.output_payload);

  useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const popH = 320;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      setPos({ top: spaceBelow >= popH ? rect.bottom + 4 : Math.max(4, rect.top - popH - 4), left: rect.left });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!btnRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="inline-block">
      <button ref={btnRef}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium"
        style={{ background: "rgba(90,138,176,0.10)", border: "1px solid rgba(90,138,176,0.22)", color: C.fg2 }}
        onClick={() => setOpen(!open)}
      >
        <span className="text-[10px] font-bold uppercase tracking-wider px-1 rounded leading-none"
          style={{ color: "#7aaccc", background: "rgba(90,138,176,0.15)", padding: "2px 4px" }}>agent</span>
        <span style={{ color: C.fg4 }}>{a.name}</span>
        <span style={{ color: C.fg0, fontSize: "10px" }}>{a.tool_count} tools &middot; {fmt(a.duration_ms)}</span>
        <Chevron open={open} size={10} />
      </button>

        {open && pos && (
          <div
            className="fixed z-[9999] rounded-lg shadow-xl flex flex-col"
            style={{ top: pos.top, left: Math.min(pos.left, window.innerWidth - 380), width: 360, maxHeight: 340, background: C.elevated, border: `1px solid ${C.borderLight}` }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="p-3 space-y-2 overflow-auto sb flex-1 min-h-0">
              {/* Input — shown as a user-message bubble */}
              {agentInput && (
                <div className="flex justify-end">
                  <div className="max-w-[90%] px-2.5 py-1.5 rounded-2xl rounded-br-md" style={{ background: C.user }}>
                    <pre className="text-[11px] font-sans leading-snug whitespace-pre-wrap" style={{ color: C.fg3 }}>{trunc(agentInput, 150)}</pre>
                  </div>
                </div>
              )}

              {/* Tools */}
              {agentToolSpans.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agentToolSpans.map(s => (
                    <span key={s.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono"
                      style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${C.border}`, color: C.fg3 }}>
                      <Check /> {s.name} <span style={{ color: C.fg0 }}>{fmt(s.duration_ms)}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* Output */}
              {agentOutput?.output_payload && (
                <div>
                  <div className="text-[9px] uppercase tracking-wide mb-0.5 font-medium" style={{ color: C.fg0 }}>Output</div>
                  <pre className="text-[11px] font-sans leading-relaxed whitespace-pre-wrap" style={{ color: C.fg2 }}>{trunc(agentOutput.output_payload, 150)}</pre>
                </div>
              )}

            </div>

            {/* Footer — always visible */}
            <div className="flex-shrink-0 flex items-center justify-between px-3 py-2" style={{ borderTop: `1px solid ${C.border}` }}>
              {onDiveIn ? (
                <Button onClick={() => { setOpen(false); onDiveIn(a.root_span_id); }}>
                  Open Sub-Agent &rarr;
                </Button>
              ) : <div />}
              <div className="text-[10px] font-mono text-right" style={{ color: C.fg0 }}>
                {a.model && <>{a.model} &middot; </>}
                {a.llm_count} LLM &middot; {a.tool_count} tools &middot; {fmt(a.duration_ms)}
                {a.total_input_tokens > 0 && <> &middot; {a.total_input_tokens.toLocaleString()} in</>}
                {a.total_output_tokens > 0 && <> &middot; {a.total_output_tokens.toLocaleString()} out</>}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

function UserBubble({ content, collapsible }: { content: string; collapsible?: boolean }) {
  const lines = content.split("\n").length;
  const canCollapse = collapsible && (content.length > 120 || lines > 3);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className="px-3.5 py-2.5 rounded-2xl rounded-br-md"
      style={{ background: C.user }}
    >
      <pre
        className="text-[13px] leading-relaxed font-sans whitespace-pre-wrap"
        style={{
          color: C.fg3,
          ...(collapsed ? { maxHeight: 22, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const } : {}),
        }}
      >
        {content}
      </pre>
      {canCollapse && (
        <button className="text-[10px] font-mono mt-0.5 px-1.5 py-0.5 -ml-1.5 rounded transition-colors hover:bg-white/10"
          style={{ color: C.fg1 }}
          onClick={() => setCollapsed(!collapsed)}>{collapsed ? "expand" : "collapse"}</button>
      )}
    </div>
  );
}

function UserMessage({ content, parts, onEdit }: { content: string; parts?: string[]; onEdit?: (content: string) => void }) {
  const segments = parts && parts.length > 1 ? parts : [content];
  const multiPart = segments.length > 1;

  return (
    <div className="group/usermsg flex justify-end px-4 pt-6 pb-2">
      <div className="relative" style={{ width: multiPart ? "max(50%, 400px)" : undefined, maxWidth: "max(50%, 400px)" }}>
        {multiPart ? (
          <div className="space-y-1.5">
            {segments.map((seg, i) => (
              <UserBubble key={i} content={seg} collapsible />
            ))}
          </div>
        ) : (
          <UserBubble content={segments[0]} />
        )}
        {onEdit && (
          <button
            className="absolute -bottom-1.5 -right-1.5 p-1.5 rounded-full opacity-0 group-hover/usermsg:opacity-100 transition-opacity"
            style={{
              background: "rgba(255,255,255,0.08)",
              backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
              border: "1px solid rgba(255,255,255,0.15)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
              color: C.fg2,
            }}
            title="Edit & replay"
            onClick={() => onEdit(content)}
          >
            <Pencil className="size-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function LLMOutput({ content, md }: { content: string; md: boolean }) {
  return (
    <div>
      <div className="max-w-[85%]">
        {md ? (
          <div className="text-message leading-relaxed" style={{ color: C.fg3 }}>
            <Markdown>{content}</Markdown>
          </div>
        ) : (
          <pre className="leading-relaxed font-sans whitespace-pre-wrap text-message" style={{ color: C.fg3 }}>
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

function RenderModeToggle({ md, onChange }: { md: boolean; onChange: (md: boolean) => void }) {
  const baseStyle: React.CSSProperties = {
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 4,
    cursor: "pointer",
    border: "none",
    outline: "none",
    fontWeight: 400,
    transition: "color 120ms",
    background: "transparent",
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5" style={{ border: `1px solid rgba(255,255,255,0.17)` }}>
      <button
        type="button"
        aria-pressed={md}
        style={{ ...baseStyle, color: md ? "#b4c0c7" : C.fg0 }}
        onClick={() => onChange(true)}
      >
        Markdown
      </button>
      <span style={{ color: C.fg0, opacity: 0.5, fontSize: 10 }}>/</span>
      <button
        type="button"
        aria-pressed={!md}
        style={{ ...baseStyle, color: !md ? "#b4c0c7" : C.fg0 }}
        onClick={() => onChange(false)}
      >
        Raw
      </button>
    </div>
  );
}

function ActiveSpinner({ isActive, lastUpdatedAt, liveEvents, spans }: {
  isActive?: boolean; lastUpdatedAt?: number; liveEvents: LiveEvent[]; spans: Span[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [isActive]);

  if (!isActive || !lastUpdatedAt) return null;

  const hasFinished = spans.some(s => {
    if (!s.attributes) return false;
    try {
      const attrs = JSON.parse(s.attributes);
      const reason = attrs["ai.response.finishReason"];
      return reason && reason !== "unknown";
    } catch { return false; }
  });
  if (hasFinished) return null;

  const elapsed = now - lastUpdatedAt;
  if (elapsed < 1000 || elapsed > 10000) return null;

  const lastLive = liveEvents.length > 0 ? liveEvents[liveEvents.length - 1].timestamp : 0;
  if (now - lastLive < 500) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="flex gap-1">
        {[0, 1, 2].map(i => (
          <div key={i} className="size-1.5 rounded-full"
            style={{ background: C.fg0, animation: "bounce-dot 1.4s infinite ease-in-out", animationDelay: `${i * 0.16}s` }} />
        ))}
      </div>
    </div>
  );
}

function SmoothTextDelta({ content, enabled, as: Tag = "pre", className, style }: {
  content: string; enabled: boolean; as?: "pre" | "span" | "div"; className?: string; style?: React.CSSProperties;
}) {
  const displayed = useSmoothText(content, enabled);
  return (
    <Tag className={className ?? "font-sans whitespace-pre-wrap text-message"} style={style ?? { color: C.fg3 }}>{displayed}</Tag>
  );
}

function LLMErrorBanner({ content }: { content: string }) {
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const formatted = tryJson(content);

  return (
    <div
      ref={ref}
      className="relative inline-flex items-center gap-1.5 cursor-default"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
        style={{ background: "rgba(235,20,20,0.08)", border: "1px solid rgba(235,20,20,0.18)" }}>
        <AlertCircle />
        <span className="text-[12px] font-medium" style={{ color: C.red }}>LLM Error</span>
        <span className="text-[11px] font-mono truncate max-w-[300px]" style={{ color: "rgba(235,20,20,0.7)" }}>
          {trunc(formatted, 80)}
        </span>
      </div>
      {hovered && (
        <div className="absolute left-0 bottom-full mb-2 z-[9999] rounded-xl shadow-2xl overflow-hidden"
          style={{
            width: Math.min(500, window.innerWidth - 60),
            maxHeight: 320,
            background: "rgba(20,8,8,0.85)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            border: "1px solid rgba(235,20,20,0.25)",
            boxShadow: "0 8px 32px rgba(235,20,20,0.15), 0 0 0 1px rgba(235,20,20,0.1)",
          }}>
          <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: "1px solid rgba(235,20,20,0.15)" }}>
            <AlertCircle />
            <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: C.red }}>Error Details</span>
          </div>
          <div className="p-3 overflow-auto" style={{ maxHeight: 270 }}>
            <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words" style={{ color: "rgba(235,100,100,0.9)" }}>
              {formatted}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

const RENDER_MODE_KEY = "rd_llm_render_mode";
const EMPTY_SUB_AGENTS: SubAgent[] = [];

export function ChatFlow({ spans, liveEvents, subAgents = EMPTY_SUB_AGENTS, onDiveIn, isActive, lastUpdatedAt, onEditMessage, replayError }: {
  spans: Span[]; liveEvents: LiveEvent[]; subAgents?: SubAgent[]; onDiveIn?: (rootSpanId: string) => void; isActive?: boolean; lastUpdatedAt?: number; onEditMessage?: (content: string) => void; replayError?: { code: string; message: string } | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colorMap = useMemo(() => new Map<string, string>(), []);
  const [md, setMd] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(RENDER_MODE_KEY) !== "raw";
  });
  const handleMdChange = (next: boolean) => {
    setMd(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RENDER_MODE_KEY, next ? "markdown" : "raw");
    }
  };

  const items = useMemo(() => {
    const all: ChatItem[] = [];

    const parentSpanIds = new Set(spans.map(s => s.id));
    const doChildNames = new Set(["ai.streamText.doStream", "ai.streamText.doGenerate", "ai.generateText.doGenerate"]);
    const llmSpans: Span[] = [];
    // Collect doStream/doGenerate children keyed by parent — they hold the full
    // conversation history (system prompt, previous messages, tool results) that
    // the parent span's ai.prompt doesn't include.
    const doChildrenByParent = new Map<string, Span[]>();

    // Sub-agent root spans render as agent blocks; their non-root spans are
    // hidden from the main view and only shown when the user dives in.
    const agentRootIds = new Set(subAgents.map(a => a.root_span_id));
    const agentSpanIds = new Set(subAgents.flatMap(a => a.span_ids));

    for (const span of spans) {
      if (agentSpanIds.has(span.id) && !agentRootIds.has(span.id)) continue;

      if (doChildNames.has(span.name) && span.parent_span_id && parentSpanIds.has(span.parent_span_id)) {
        const siblings = doChildrenByParent.get(span.parent_span_id) ?? [];
        siblings.push(span);
        doChildrenByParent.set(span.parent_span_id, siblings);
        continue;
      }

      if (agentRootIds.has(span.id)) {
        const agent = subAgents.find(a => a.root_span_id === span.id)!;
        all.push({ type: "sub_agent", agent, time: span.start_time_ms });
      } else if (span.span_type === "TOOL_CALL") {
        all.push({ type: "tool", span, time: span.start_time_ms });
      } else if (span.span_type?.includes("LLM")) {
        llmSpans.push(span);
      }
    }

    const hasRealOtlpLlmSpan = llmSpans.some(span => !isSyntheticPartialLlmSpan(span));
    const visibleLlmSpans = hasRealOtlpLlmSpan
      ? llmSpans.filter(span => !isSyntheticPartialLlmSpan(span))
      : llmSpans;

    let prevMsgCount = 0;
    for (let i = 0; i < visibleLlmSpans.length; i++) {
      const span = visibleLlmSpans[i];
      // Prefer the richest child span's messages — the last doStream/doGenerate
      // child has the full conversation including system prompt, all previous
      // messages, and tool results. Fall back to the parent span if no children.
      const children = doChildrenByParent.get(span.id);
      const richestChild = children?.length ? children[children.length - 1] : null;
      const firstChild = children?.length ? children[0] : null;
      const messages = (richestChild ? messagesFromSpan(richestChild) : null) ?? messagesFromSpan(span);
      // For the first LLM call's messages use the first child (initial prompt),
      // since richestChild may include tool-result context from later steps.
      const firstMessages = (firstChild ? messagesFromSpan(firstChild) : null) ?? messagesFromSpan(span);
      if (messages && messages.length > 0) {
        const systemMsgs = messages.filter(m => m.role === "system");
        const nonSystem = messages.filter(m => m.role !== "system");
        if (i === 0) {
          // Use firstMessages for the initial user message extraction
          const initMsgs = firstMessages ?? messages;
          const initNonSystem = initMsgs.filter(m => m.role !== "system");
          const lastUserIdx = initNonSystem.reduce((acc, m, idx) => m.role === "user" ? idx : acc, -1);
          const prevMessages = lastUserIdx > 0 ? initNonSystem.slice(0, lastUserIdx) : [];
          if (systemMsgs.length > 0 || prevMessages.length > 0) {
            all.push({ type: "system_msg", content: systemMsgs.length > 0 ? systemMsgs.map(m => m.content).join("\n\n") : "", time: span.start_time_ms - 2, prevMessages: prevMessages.length > 0 ? prevMessages : undefined });
          }
        }
        const newMsgs = i === 0 ? nonSystem : nonSystem.slice(Math.max(0, prevMsgCount - systemMsgs.length));
        const lastUser = newMsgs.filter(m => m.role === "user").pop();
        if (lastUser) all.push({ type: "user_msg", content: lastUser.content, parts: lastUser.parts, time: span.start_time_ms });
        prevMsgCount = messages.length;
      } else if (span.input_payload) {
        all.push({ type: "user_msg", content: span.input_payload, time: span.start_time_ms });
      }
      // Add outputs from each doStream/doGenerate child (each is a separate
      // LLM call — e.g. before tool use and after). Fall back to the parent
      // span's output when no child carries an output_payload, so a completed
      // turn always has something to render even if children only captured
      // tool calls / reasoning.
      const childrenWithOutput = children?.filter(c => c.output_payload) ?? [];
      if (childrenWithOutput.length > 0) {
        for (const child of childrenWithOutput) {
          all.push({ type: "llm_out", span: child, time: child.end_time_ms });
        }
      } else if (span.output_payload) {
        all.push({ type: "llm_out", span, time: span.end_time_ms });
      }
    }

    // A text_delta is superseded only when an llm_out item will render the
    // same text in its place. Suppressing purely by timestamp dropped text
    // when the corresponding span shipped without an output_payload, leaving
    // the turn blank. Track the end times of the spans we'll actually render
    // as llm_out items, and only drop deltas covered by those.
    const renderedLLMEndTimes = all.flatMap(item => item.type === "llm_out" ? [item.span.end_time_ms] : []);

    const completedCounts = new Map<string, number>();
    for (const s of spans) {
      if (s.span_type === "TOOL_CALL" && s.end_time_ms) {
        completedCounts.set(s.name, (completedCounts.get(s.name) ?? 0) + 1);
      }
    }
    const seenStart = new Map<string, number>();
    const seenResult = new Map<string, number>();

    const spanById = new Map(spans.map(s => [s.id, s]));

    for (const evt of liveEvents) {
      if (evt.type === "tool_start" || evt.type === "tool_result") {
        // For tool_start, content is the tool name.
        // For tool_result, content is the result data; look up tool name from the span.
        const name = evt.type === "tool_start"
          ? (evt.content ?? "")
          : (evt.span_id ? spanById.get(evt.span_id)?.name : null) ?? "";
        if (!name) continue;
        const map = evt.type === "tool_start" ? seenStart : seenResult;
        const n = (map.get(name) ?? 0) + 1;
        map.set(name, n);
        if (n <= (completedCounts.get(name) ?? 0)) continue;
        if (evt.type === "tool_start") {
          all.push({ type: "live_tool_start", name, argsPreview: argsPreview(extractLiveToolArgs(evt.metadata)), time: evt.timestamp });
        }
        if (evt.type === "tool_result") all.push({ type: "live_tool_result", name, time: evt.timestamp });
      } else if (evt.type === "reasoning" || evt.type === "reasoning-delta" || evt.type === "reasoning_delta") {
        // Reasoning is kept even after completion — it's valuable context.
        all.push({ type: "reasoning", content: evt.content ?? "", time: evt.timestamp });
      } else if (evt.type === "text_delta") {
        const superseded = renderedLLMEndTimes.some(t => evt.timestamp <= t);
        if (!superseded) {
          all.push({ type: "text_delta", content: evt.content ?? "", time: evt.timestamp });
        }
      }
    }

    // Tie-break by item role so a turn's input → work → output ordering is
    // preserved even when timestamps coincide (e.g. the synthetic LLM span
    // shares its start_time with the first tool span on fast turns).
    const chatItemPriority = (t: ChatItem["type"]): number => {
      if (t === "user_msg" || t === "system_msg") return 0;
      if (t === "llm_out") return 2;
      return 1;
    };
    all.sort((a, b) => (a.time - b.time) || (chatItemPriority(a.type) - chatItemPriority(b.type)));

    const grouped: ChatItem[] = [];
    let tg: { type: "tool_group"; items: ToolGroupItem[]; time: number; liveTools?: LiveToolItem[] } | null = null;
    for (const item of all) {
      if (item.type === "tool" || item.type === "sub_agent" || item.type === "live_tool_start" || item.type === "live_tool_result") {
        if (!tg) tg = { type: "tool_group", items: [], time: item.time };
        if (item.type === "tool") tg.items.push({ type: "tool", span: item.span });
        else if (item.type === "sub_agent") tg.items.push({ type: "sub_agent", agent: item.agent });
        else { if (!tg.liveTools) tg.liveTools = []; tg.liveTools.push(item); }
      } else {
        if (tg) { grouped.push(tg); tg = null; }
        grouped.push(item);
      }
    }
    if (tg) grouped.push(tg);

    const merged: ChatItem[] = [];
    for (const item of grouped) {
      const prev = merged[merged.length - 1];
      if (item.type === "reasoning" && prev?.type === "reasoning") {
        prev.content += item.content;
      } else if (item.type === "text_delta" && prev?.type === "text_delta") {
        prev.content += item.content;
      } else {
        merged.push(item);
      }
    }
    return merged;
  }, [spans, liveEvents, subAgents]);

  if (items.length === 0) {
    if (replayError) {
      return (
        <div className="flex flex-col items-center justify-center h-48 text-sm gap-2 px-6 text-center" style={{ color: C.fg1 }}>
          <div className="font-medium" style={{ color: C.red }}>Replay failed</div>
          <div className="font-mono text-xs opacity-70">{replayError.code}</div>
          <div className="max-w-xl text-xs whitespace-pre-wrap">{replayError.message}</div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center h-48 text-sm gap-2" style={{ color: C.fg1 }}>
        Waiting for events <Dots />
      </div>
    );
  }

  const hasLLMOutput = items.some(it => it.type === "llm_out");

  return (
    <div ref={scrollRef} className="space-y-1.5 py-2 pb-24">
      <div className="px-3"><FlameTimeline spans={spans} /></div>
      {(() => { let seenLLM = false; return items.map((item, i) => {
        const isFirstLLM = hasLLMOutput && item.type === "llm_out" && !seenLLM;
        if (item.type === "llm_out") seenLLM = true;
        if (item.type === "tool_group") {
          return (
            <div key={`tg${i}`} className="flex flex-wrap gap-1.5 px-4 py-0.5 items-center">
              {item.items.map((gi, j) =>
                gi.type === "tool"
                  ? <ToolCallPill key={gi.span.id} span={gi.span} colorMap={colorMap} />
                  : <SubAgentBlock key={`sa${j}`} agent={gi.agent} spans={spans} onDiveIn={onDiveIn} />
              )}
              {item.liveTools?.map((lt, j) => { const tc = spanColor(lt.name, colorMap); return lt.type === "live_tool_start" ? (
                <span key={`lts${j}`} className="inline-flex items-center gap-1.5 py-1 rounded text-xs font-medium"
                  style={{ paddingLeft: 7, paddingRight: 12, background: `color-mix(in srgb, ${tc} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${tc} 20%, transparent)`, color: tc }}>
                  <Spinner style={{ marginRight: 3 }} />
                  <span style={{ color: "#fff" }}>{lt.name}</span>
                  {lt.argsPreview && <span style={{ color: C.fg2, fontWeight: 400 }}>({lt.argsPreview})</span>}
                </span>
              ) : lt.type === "live_tool_result" ? (
                <span key={`ltr${j}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium"
                  style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${C.border}`, color: C.fg2 }}>
                  <Check /> <span style={{ color: C.fg4 }}>{lt.name}</span>
                </span>
              ) : null; })}
            </div>
          );
        }

        if (item.type === "system_msg") {
          return (
            <div key={`sys${i}`} className="px-4 space-y-1.5">
              {item.content && <MessageList messages={[{ role: "system", content: item.content }]} />}
              {item.prevMessages && item.prevMessages.length > 0 && (
                <PreviousMessages messages={item.prevMessages} />
              )}
            </div>
          );
        }

        if (item.type === "user_msg") {
          return <UserMessage key={`usr${i}`} content={item.content} parts={item.parts} onEdit={onEditMessage} />;
        }

        if (item.type === "llm_out") {
          const s = item.span;
          const isErr = s.status === "ERROR";
          return (
            <div key={`lo${i}`} className="px-4 py-2">
              {isFirstLLM && (
                <div className="flex justify-start mb-2" style={{ marginLeft: -6 }} data-testid="llm-render-mode-toolbar">
                  <RenderModeToggle md={md} onChange={handleMdChange} />
                </div>
              )}
              {isErr && s.output_payload && (
                <div className="max-w-[85%]"><LLMErrorBanner content={s.output_payload} /></div>
              )}
              {!isErr && s.output_payload && (
                <LLMOutput content={s.output_payload} md={md} />
              )}
            </div>
          );
        }

        if (item.type === "reasoning") {
          return (
            <div key={`r${i}`} className="px-4 text-[11px] italic py-2.5 whitespace-pre-wrap" style={{ color: C.fg0, lineHeight: "1.6" }}>
              <SmoothTextDelta content={item.content} enabled={true} as="span" className="whitespace-pre-wrap" style={{ color: "inherit" }} />
            </div>
          );
        }

        if (item.type === "text_delta") {
          return (
            <div key={`td${i}`} className="px-4">
              <SmoothTextDelta content={item.content} enabled={true} />
            </div>
          );
        }

        return null;
      }); })()}
      <ActiveSpinner isActive={isActive} lastUpdatedAt={lastUpdatedAt} liveEvents={liveEvents} spans={spans} />
    </div>
  );
}

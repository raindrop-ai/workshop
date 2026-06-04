import { useEffect, useRef, useState } from "react";
import { Chevron, Check, Spinner, AlertCircle } from "./Icons";
import { C, spanColor } from "../utils/colors";
import { argsPreview, fmt, trunc, tryJson } from "../utils/helpers";
import { getNormalizedTool, type Span } from "../utils/types";

function approxTokens(s: string | null | undefined): string | null {
  if (!s || s.length < 20) return null;
  const tokens = Math.round(s.length / 4);
  if (tokens < 10) return null;
  if (tokens < 1000) return `~${tokens} tok`;
  return `~${(tokens / 1000).toFixed(1)}k tok`;
}

export function ToolCallPill({ span, colorMap }: { span: Span; colorMap: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const err = span.status === "ERROR";
  const name = getNormalizedTool(span)?.name ?? span.name;
  const pending = span.status === "UNSET" && !span.end_time_ms;
  const icon = pending ? <Spinner style={{ marginRight: 3 }} /> : err ? <AlertCircle /> : <Check />;
  const color = spanColor(name, colorMap);
  const preview = argsPreview(span.input_payload);
  const resultTokens = approxTokens(span.output_payload);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.spanId === span.id) {
        setOpen(true);
        setFlash(true);
        setTimeout(() => {
          ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 50);
        setTimeout(() => setFlash(false), 1500);
      }
    };
    document.addEventListener("workshop:focus-tool", handler);
    return () => document.removeEventListener("workshop:focus-tool", handler);
  }, [span.id]);

  return (
    <div
      ref={ref}
      data-tool-span-id={span.id}
      className={open ? "basis-full max-w-full" : "inline-block max-w-full"}
      style={{
        transition: "background 300ms, box-shadow 300ms",
        borderRadius: 8,
        background: flash ? `color-mix(in srgb, ${color} 14%, transparent)` : undefined,
        boxShadow: flash ? `0 0 0 2px color-mix(in srgb, ${color} 42%, transparent)` : undefined,
      }}
    >
      <button
        className={`inline-flex items-center gap-1.5 ${pending ? '' : 'px-2.5'} py-1 rounded text-xs font-medium transition-colors w-fit max-w-full`}
        style={{
          ...(pending ? { paddingLeft: 7, paddingRight: 12 } : {}),
          background: err ? "rgba(204,85,85,0.08)" : pending ? `color-mix(in srgb, ${color} 12%, transparent)` : "rgba(255,255,255,0.08)",
          color: err ? C.red : pending ? color : C.fg2,
          border: `1px solid ${err ? "rgba(204,85,85,0.15)" : pending ? `color-mix(in srgb, ${color} 20%, transparent)` : "rgba(255,255,255,0.15)"}`,
        }}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span style={{ color: err ? undefined : pending ? "#fff" : C.fg4 }}>{name}</span>
        {preview && (
          <span className="truncate max-w-[200px]" style={{ color: C.fg0, fontSize: "10px" }}>({preview})</span>
        )}
        {span.duration_ms > 0 && <span style={{ color: C.fg0, fontSize: "10px", marginLeft: 2 }}>{fmt(span.duration_ms)}</span>}
        {resultTokens && <span style={{ color: C.fg0, fontSize: "10px" }}>{resultTokens}</span>}
        <Chevron open={open} size={10} />
      </button>

      {open && (
        <div
          className="mt-1.5 rounded-lg overflow-hidden"
          style={{ background: C.elevated, border: `1px solid ${C.borderLight}` }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: `1px solid ${C.border}` }}>
            {err && <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ color: C.red, background: "rgba(204,102,102,0.1)" }}>ERROR</span>}
            <span className="text-[11px] font-mono font-medium" style={{ color: err ? C.red : C.fg4 }}>{name}</span>
            {span.duration_ms > 0 && <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{fmt(span.duration_ms)}</span>}
            {resultTokens && <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{resultTokens}</span>}
          </div>
          {/* Error banner */}
          {err && span.output_payload && (
            <div className="px-3 py-2" style={{ background: "rgba(204,102,102,0.06)", borderBottom: `1px solid rgba(204,102,102,0.1)` }}>
              <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words" style={{ color: C.red }}>{trunc(tryJson(span.output_payload), 300)}</pre>
            </div>
          )}
          {/* Split panes */}
          <div className="flex flex-col md:flex-row" style={{ maxHeight: 400 }}>
            {span.input_payload && (
              <div className="flex-1 min-w-0 p-2.5 overflow-auto sb" style={{ borderRight: span.output_payload ? `1px solid ${C.border}` : "none" }}>
                <div className="text-[9px] uppercase tracking-wide mb-1 font-sans font-medium" style={{ color: C.fg0 }}>Input</div>
                <pre className="text-[11px] font-mono leading-relaxed select-all whitespace-pre-wrap break-words" style={{ color: C.fg2 }}>{tryJson(span.input_payload)}</pre>
              </div>
            )}
            {span.output_payload && (
              <div className="flex-1 min-w-0 p-2.5 overflow-auto sb">
                <div className="text-[9px] uppercase tracking-wide mb-1 font-sans font-medium" style={{ color: C.fg0 }}>Output</div>
                <pre className="text-[11px] font-mono leading-relaxed select-all whitespace-pre-wrap break-words" style={{ color: err ? C.red : C.fg2 }}>{tryJson(span.output_payload)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

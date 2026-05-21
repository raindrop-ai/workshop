import { Star, RotateCcw } from "lucide-react";
import { C } from "../utils/colors";
import { ago, isActive } from "../utils/helpers";
import { useSavedEvent } from "../api/saved-runs";
import { parseReplayMetadata } from "../utils/types";
import type { Run } from "../utils/types";

export function RunListItem({ run, selected, highlighted, faded, onClick }: {
  run: Run;
  selected: boolean;
  highlighted?: boolean;
  faded?: boolean;
  onClick: () => void;
}) {
  const active = isActive(run);
  const saved = !!useSavedEvent(run.id);
  const replayMeta = parseReplayMetadata(run);
  const isReplay = !!replayMeta;

  const baseName = isReplay
    ? (run.event_name ?? "").replace(/^replay:/, "") || run.name || run.id.slice(0, 5)
    : (run.event_name ?? "").replace(/^replay:/i, "").trim()
      || run.name?.trim()
      || run.id.slice(0, 5);
  const traceIdShort = run.id.slice(0, 5);
  const displayTitle = `${baseName} (${traceIdShort})`;

  return (
    <div data-run-id={run.id} style={{ opacity: faded ? 0.4 : 1, transition: "opacity 150ms" }}>
      <button className="w-full text-left p-2.5 rounded-lg transition-all duration-150"
        style={{
          background: selected ? "rgba(255,255,255,0.08)" : highlighted ? "rgba(255,255,255,0.06)" : "transparent",
          border: selected ? "1px solid rgba(255,255,255,0.15)" : highlighted ? "1px solid rgba(255,255,255,0.10)" : "1px solid transparent",
        }}
        onMouseEnter={(e) => { if (!selected && !highlighted) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "rgba(255,255,255,0.08)" : highlighted ? "rgba(255,255,255,0.06)" : "transparent"; }}
        onClick={onClick}>
        <div className="flex items-center gap-2">
          {active && <div className="size-2 rounded-full flex-shrink-0 pulse-dot" style={{ background: C.green }} />}
          {!active && <div className="size-2 flex-shrink-0" />}
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium truncate" style={{ color: C.fg4, opacity: saved ? 1 : 0.9 }}>
                {displayTitle}
              </span>
              {saved && <span className="shrink-0 flex items-center justify-center size-5 rounded-full" style={{ background: "rgba(255,255,255,0.12)" }}><Star className="size-3" style={{ color: "#fff", fill: "#fff" }} /></span>}
            </div>
            <div className="flex items-center gap-2 mt-0.5 overflow-hidden">
              {isReplay && (
                <>
                  <RotateCcw className="size-2.5 shrink-0" style={{ color: C.fg0 }} />
                  <span className="text-[11px]" style={{ color: C.fg0, marginLeft: -4, marginTop: -1 }}>replay of {replayMeta!.replay.sourceRunId.slice(0, 5)}</span>
                </>
              )}
              <span className="text-[10px] flex-shrink-0" style={{ color: C.fg0 }}>{ago(run.last_updated_at)}</span>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

export function RunTableRow({ run, selected, highlighted, faded, onClick }: {
  run: Run;
  selected: boolean;
  highlighted?: boolean;
  faded?: boolean;
  onClick: () => void;
}) {
  const active = isActive(run);
  const saved = !!useSavedEvent(run.id);
  const replayMeta = parseReplayMetadata(run);
  const isReplay = !!replayMeta;
  const baseName = isReplay
    ? (run.event_name ?? "").replace(/^replay:/, "") || run.name || run.id.slice(0, 5)
    : (run.event_name ?? "").replace(/^replay:/i, "").trim()
      || run.name?.trim()
      || run.id.slice(0, 5);
  return (
    <div data-run-id={run.id} style={{ opacity: faded ? 0.4 : 1, transition: "opacity 150ms" }}>
      <button
        className="grid w-full items-center px-3 py-2 text-left transition-all duration-150"
        style={{
          gridTemplateColumns: "74px minmax(150px, 1.6fr) 76px minmax(86px, 1fr) 74px",
          columnGap: 8,
          background: selected ? "rgba(91,141,239,0.13)" : highlighted ? "rgba(255,255,255,0.06)" : "transparent",
          borderTop: "1px solid transparent",
          borderBottom: selected ? "1px solid rgba(91,141,239,0.26)" : "1px solid rgba(255,255,255,0.035)",
          color: C.fg3,
        }}
        onMouseEnter={(e) => { if (!selected && !highlighted) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "rgba(91,141,239,0.13)" : highlighted ? "rgba(255,255,255,0.06)" : "transparent"; }}
        onClick={onClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="size-2 rounded-full flex-shrink-0" style={{ background: active ? C.green : "rgba(255,255,255,0.16)" }} />
          <span className="text-[11px] font-mono" style={{ color: active ? C.green : C.fg0 }}>
            {active ? "running" : run.finished ? "done" : "idle"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          {isReplay && <RotateCcw className="size-3 shrink-0" style={{ color: C.fg0 }} />}
          <span className="truncate text-[13px] font-medium" style={{ color: C.fg4 }}>
            {baseName}
          </span>
          {saved && <span className="shrink-0 flex items-center justify-center size-5 rounded-full" style={{ background: "rgba(255,255,255,0.12)" }}><Star className="size-3" style={{ color: "#fff", fill: "#fff" }} /></span>}
          {isReplay && (
            <span className="shrink-0 text-[10px] font-mono" style={{ color: C.fg0 }}>
              replay {replayMeta!.replay.sourceRunId.slice(0, 5)}
            </span>
          )}
        </div>

        <div className="truncate text-[11px] font-mono" style={{ color: selected ? C.fg3 : C.fg1 }}>
          {run.id.slice(0, 8)}
        </div>

        <div className="truncate text-[11px] font-mono" style={{ color: C.fg1 }}>
          {run.model || "—"}
        </div>

        <div className="text-[11px] font-mono" style={{ color: C.fg0 }}>
          {ago(run.last_updated_at)}
        </div>
      </button>
    </div>
  );
}

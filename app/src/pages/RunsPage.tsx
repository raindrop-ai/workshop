import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { runPath } from "../utils/navigation";
import { RunListItem } from "../components/RunList";
import { RunDetail } from "../components/RunDetail";
import { EmptyState } from "../components/EmptyState";
import { ReplayView } from "../components/ReplayView";
import { useReplay } from "../hooks/use-replay";
import { RotateCcw, ArrowRight, X, ChevronDown } from "lucide-react";
import { C } from "../utils/colors";
import { fetchPrices } from "../utils/costs";
import { parseReplayMetadata } from "../utils/types";
import type { Run } from "../utils/types";
import { useWorkshopConnected, useWorkshopMessage } from "../hooks/use-workshop-ws";

const FIRST_TIME_SETUP_DISMISSED_KEY = "workshop:firstTimeSetupDismissed";

function loadFirstTimeSetupDismissed(): boolean {
  try {
    return localStorage.getItem(FIRST_TIME_SETUP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFirstTimeSetupDismissed(): void {
  try {
    localStorage.setItem(FIRST_TIME_SETUP_DISMISSED_KEY, "1");
  } catch {
    /* ignore */
  }
}

function isDefaultDemoRun(run: Run): boolean {
  if (run.id.startsWith("demo_")) return true;
  if (!run.metadata) return false;
  try {
    const metadata = JSON.parse(run.metadata);
    return metadata?.demo === true && metadata?.default === true;
  } catch {
    return false;
  }
}

export function RunsPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? decodeURIComponent(routeRunId) : null;
  const [runs, setRuns] = useState<Run[]>([]);
  const [replayOriginalId, setReplayOriginalId] = useState<string | null>(null);
  const [replayCompare, setReplayCompare] = useState(false);
  const replay = useReplay();
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const wsConnected = useWorkshopConnected();
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
  const [firstTimeSetupDismissed, setFirstTimeSetupDismissed] = useState(loadFirstTimeSetupDismissed);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { fetchPrices(); }, []);
  const fetchRuns = useCallback(async () => {
    try {
      const fresh: Run[] = await (await fetch("/api/runs")).json();
      setRuns(prev => {
        if (prev.length === 0) return fresh;
        const freshById = new Map(fresh.map(r => [r.id, r]));
        const prevIds = new Set(prev.map(r => r.id));
        const freshIds = new Set(fresh.map(r => r.id));
        // If run set changed (added/deleted), use server ordering to avoid
        // stale runs appearing at wrong positions.
        const same = prevIds.size === freshIds.size && [...prevIds].every(id => freshIds.has(id));
        if (!same) return fresh;
        // Same set of runs — update data in place, keep client ordering
        return prev.map(r => freshById.get(r.id)!);
      });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);
  useWorkshopMessage(fetchRuns);

  const hasUserTraces = useMemo(
    () => runs.some((run) => !isDefaultDemoRun(run)),
    [runs],
  );

  useEffect(() => {
    if (!hasUserTraces || firstTimeSetupDismissed) return;
    saveFirstTimeSetupDismissed();
    setFirstTimeSetupDismissed(true);
  }, [firstTimeSetupDismissed, hasUserTraces]);

  useEffect(() => {
    if (runs.length === 0 || replayOriginalId) return;
    if (selectedId && runs.some((run) => run.id === selectedId)) return;
    const firstUserTrace = runs.find((run) => !isDefaultDemoRun(run));
    if (firstUserTrace) navigate(runPath(firstUserTrace.id), { replace: true });
  }, [navigate, replayOriginalId, runs, selectedId]);

  // Refresh active status display every 5s (tick counter avoids changing runs reference)
  const [, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(i);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        if (search) { setSearch(""); searchRef.current?.blur(); }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [search]);

  // When replay completes, select the replay run and scroll list to top
  useEffect(() => {
    if (replay.replayRunId && replayOriginalId) {
      navigate(runPath(replay.replayRunId), { replace: true });
      listRef.current?.scrollTo({ top: 0 });
    }
  }, [navigate, replay.replayRunId, replayOriginalId]);

  // Unique agent types (event names) for the filter dropdown
  const agentTypes = useMemo(() => {
    const names = new Set<string>();
    for (const r of runs) {
      const name = (r.event_name ?? "").replace(/^replay:/, "");
      if (name) names.add(name);
    }
    return [...names].sort();
  }, [runs]);

  const filtered = useMemo(() => {
    let list = runs;
    if (agentFilter !== "all") {
      list = list.filter(r => {
        const name = (r.event_name ?? "").replace(/^replay:/, "");
        return name === agentFilter;
      });
    }
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(r =>
      (r.event_name ?? "").toLowerCase().includes(q) ||
      (r.name ?? "").toLowerCase().includes(q) ||
      (r.user_id ?? "").toLowerCase().includes(q) ||
      (r.convo_id ?? "").toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q)
    );
  }, [runs, search, agentFilter]);


  const handleClear = async () => {
    if (!confirm("Clear all runs?")) return;
    await fetch("/api/clear", { method: "POST" });
    navigate("/runs", { replace: true });
    setRuns([]);
  };

  const dismissFirstTimeSetup = useCallback(() => {
    saveFirstTimeSetupDismissed();
    setFirstTimeSetupDismissed(true);
  }, []);

  const openDemoTrace = useCallback(async () => {
    const response = await fetch("/api/demo-traces/replay", { method: "POST" });
    if (!response.ok) throw new Error("Failed to load demo traces");
    const body = await response.json().catch(() => null) as { runIds?: string[] } | null;
    if (replayOriginalId) { replay.reset(); setReplayOriginalId(null); }
    const fresh: Run[] = await (await fetch("/api/runs")).json();
    setRuns(fresh);
    const firstDemoRunId =
      body?.runIds?.find((id) => fresh.some((run) => run.id === id)) ??
      fresh.find(isDefaultDemoRun)?.id ??
      "demo_triage";
    navigate(runPath(firstDemoRunId));
  }, [navigate, replay, replayOriginalId]);

  const handleFork = useCallback((sourceRunId: string, userMessage?: string, mode?: "local", model?: string, contextOverrides?: Record<string, any>) => {
    setReplayOriginalId(sourceRunId);
    replay.reset();
    replay.startReplay({ runId: sourceRunId, userMessage, mode: "local", model, contextOverrides });
  }, [replay]);

  const handleSelectRun = useCallback((id: string) => {
    if (replayOriginalId) { replay.reset(); setReplayOriginalId(null); }
    navigate(runPath(id));
  }, [navigate, replay, replayOriginalId]);

  useEffect(() => {
    const selected = selectedId
      ? Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-run-id]") ?? [])
          .find(el => el.dataset.runId === selectedId)
      : null;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedId, filtered]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const target = e.target as HTMLElement | null;
      const isTypingTarget =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        (target instanceof HTMLInputElement && target !== searchRef.current);
      if (isTypingTarget || filtered.length === 0) return;

      e.preventDefault();
      const currentIndex = filtered.findIndex(run => run.id === selectedId);
      const nextIndex = e.key === "ArrowDown"
        ? Math.min(currentIndex + 1, filtered.length - 1)
        : Math.max(currentIndex === -1 ? filtered.length - 1 : currentIndex - 1, 0);
      const nextRun = filtered[nextIndex];
      if (!nextRun || nextRun.id === selectedId) return;
      handleSelectRun(nextRun.id);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filtered, handleSelectRun, selectedId]);

  return (
    <div className="h-full flex">
      {/* Run list sidebar */}
      <div className="w-[248px] flex-shrink-0 flex flex-col" style={{ borderRight: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="p-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1.5">
              {/* WebSocket connection indicator */}
              <div className="w-1.5 h-1.5 rounded-full" title={wsConnected ? "Connected" : "Disconnected"}
                style={{ background: wsConnected ? C.green : C.red, opacity: wsConnected ? 0.6 : 1 }} />
              <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{wsConnected ? "connected" : "disconnected"}</span>
            </div>
            <button className="text-[10px] transition hover:text-red-400" style={{ color: "#5a6a72" }} onClick={handleClear}>
              clear
            </button>
          </div>
          {/* Search */}
          <div className="relative mb-2">
            <input
              ref={searchRef}
              className="w-full px-2 py-1.5 rounded text-[11px] font-mono outline-none"
              style={{ background: "rgba(255,255,255,0.04)", color: C.fg3, border: `1px solid ${search ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}` }}
              placeholder="Search runs..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-mono"
                style={{ color: C.fg0 }} onClick={() => setSearch("")}>
                esc
              </button>
            )}
          </div>
          {/* Agent type filter */}
          {agentTypes.length > 1 && (
            <div className="relative mb-2">
              <select
                className="w-full appearance-none px-2 py-1.5 pr-6 rounded text-[11px] font-mono outline-none cursor-pointer"
                style={{ background: "rgba(255,255,255,0.04)", color: agentFilter === "all" ? C.fg1 : C.fg3, border: `1px solid ${agentFilter !== "all" ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}` }}
                value={agentFilter}
                onChange={e => setAgentFilter(e.target.value)}
              >
                <option value="all">All agents</option>
                {agentTypes.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none" style={{ color: C.fg0 }} />
            </div>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-auto p-2 space-y-0.5 sb">
          {filtered.length === 0
              ? <div className="text-center text-xs mt-8" style={{ color: "#5a6a72" }}>
                  {search ? "No matching runs" : "No runs"}
                </div>
              : filtered.map(run => (
                  <RunListItem key={run.id} run={run}
                    selected={run.id === selectedId}
                    highlighted={run.id === hoveredSourceId}
                    faded={!!hoveredSourceId && run.id !== hoveredSourceId}
                    onClick={() => handleSelectRun(run.id)}
                  />
                ))}
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0 relative overflow-hidden">
        {(replay.state !== "idle" || replay.replayRunId) && replayOriginalId
          ? (() => {
              const origRun = runs.find(r => r.id === replayOriginalId);
              const origName = (origRun?.event_name ?? origRun?.name ?? "")?.replace(/^replay:/i, "").trim() || replayOriginalId!.slice(0, 12);
              return <ReplayView
                originalRunId={replayOriginalId}
                originalName={origName}
                replayRunId={replay.replayRunId}
                error={replay.error}
                isRunning={replay.state === "running"}
                isCancelled={replay.state === "cancelled"}
                onCancel={() => replay.cancel()}
                onReplay={() => handleFork(replayOriginalId!)}
              />;
            })()
          : selectedId
              ? (() => {
                  const selectedRun = runs.find(r => r.id === selectedId);
                  const meta = selectedRun ? parseReplayMetadata(selectedRun) : null;
                  const srcRun = meta ? runs.find(r => r.id === meta.replay.sourceRunId) : null;
                  const srcName = meta ? (srcRun?.event_name ?? srcRun?.name ?? meta.replay.sourceRunId.slice(0, 12)).replace(/^replay:/, "") : "";
                  return (
                    <div className="h-full flex flex-col">
                      {meta && (
                        <div className="flex-shrink-0 flex z-10" style={{ borderBottom: `1px solid ${C.border}` }}>
                          {/* Replay (left) header */}
                          <div
                            className="flex items-center justify-between px-3 py-1.5 min-w-0"
                            style={{ background: "rgba(255,255,255,0.10)", width: replayCompare ? "50%" : "100%" }}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <RotateCcw style={{ width: 12, height: 12, color: C.fg1, flexShrink: 0 }} />
                              <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
                                replay of{" "}
                                <button className="font-medium hover:underline transition-colors" style={{ color: C.fg3 }}
                                  onClick={() => { setReplayCompare(false); navigate(runPath(meta.replay.sourceRunId)); }}
                                  onMouseEnter={() => {
                                    const el = listRef.current?.querySelector(`[data-run-id="${meta.replay.sourceRunId}"]`);
                                    if (el) {
                                      const listRect = listRef.current!.getBoundingClientRect();
                                      const elRect = el.getBoundingClientRect();
                                      if (elRect.bottom > listRect.top && elRect.top < listRect.bottom) {
                                        setHoveredSourceId(meta.replay.sourceRunId);
                                      }
                                    }
                                  }}
                                  onMouseLeave={() => setHoveredSourceId(null)}>
                                  {srcName}
                                </button>
                                <span className="font-mono text-[10px] ml-1.5" style={{ color: C.fg0 }}>({meta.replay.sourceRunId.slice(0, 5)})</span>
                              </span>
                              {!replayCompare && (
                                <button
                                  className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded transition-colors hover:bg-white/10 flex-shrink-0"
                                  style={{ color: C.fg2, border: `1px solid rgba(255,255,255,0.15)` }}
                                  onClick={() => setReplayCompare(true)}>
                                  compare <ArrowRight className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Original (right) header — same row, mirrors the divider below */}
                          {replayCompare && (
                            <>
                              <div className="flex-shrink-0 w-[1px]" style={{ background: C.border }} />
                              <div
                                className="flex items-center justify-between px-3 py-1.5 min-w-0"
                                style={{ background: "rgba(255,255,255,0.04)", flex: 1 }}
                              >
                                <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
                                  original — <span style={{ color: C.fg3 }}>{srcName}</span>
                                </span>
                                <button
                                  className="p-0.5 rounded transition-colors hover:bg-white/10 flex-shrink-0"
                                  onClick={() => setReplayCompare(false)}
                                >
                                  <X className="h-3.5 w-3.5" style={{ color: C.fg1 }} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      <div className="flex-1 min-h-0 flex">
                        <div className="flex-1 min-w-0 overflow-auto sb">
                          <RunDetail runId={selectedId} routeBase="/runs" onForkStarted={handleFork} />
                        </div>
                        {replayCompare && meta && (
                          <>
                            <div className="flex-shrink-0 w-[1px]" style={{ background: C.border }} />
                            <div className="flex-1 min-w-0 overflow-auto sb">
                              <RunDetail key={meta.replay.sourceRunId} runId={meta.replay.sourceRunId} />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()
              : <EmptyState
                  firstTime={!hasUserTraces && !firstTimeSetupDismissed}
                  onFirstTimeDone={dismissFirstTimeSetup}
                  onSeeDemoTraces={openDemoTrace}
                />
        }
      </div>
    </div>
  );
}

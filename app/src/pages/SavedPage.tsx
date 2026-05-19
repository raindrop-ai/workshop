import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Loader2, Trash2, ChevronDown, FolderPlus, Folder, Check, Search, X, SlidersHorizontal, MessageSquareText } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { RunDetail } from "../components/RunDetail";
import { C } from "../utils/colors";
import { tracePath } from "../utils/navigation";

export interface SavedEvent {
  id: string;
  event_name: string;
  user_id: string | null;
  convo_id: string | null;
  timestamp: string;
  user_input: string | null;
  assistant_output: string | null;
  signals?: { id: string; name: string; score?: number }[];
  properties?: Record<string, unknown>;
  saved_at: number;
  summary?: string;
  source?: "local" | "cloud";
  folder?: string;
}

export interface SavedAnnotationPreview {
  id: string;
  kind: "issue" | "good" | "note";
  note: string | null;
  source: "user" | "claude-code" | "codex";
  span_id: string | null;
  created_at: number;
}

export function getSavedAnnotationPreview(event: SavedEvent): SavedAnnotationPreview | null {
  const raw = event.properties?.annotation_preview;
  if (!raw || typeof raw !== "object") return null;
  const preview = raw as Partial<SavedAnnotationPreview>;
  if (typeof preview.id !== "string") return null;
  if (preview.kind !== "issue" && preview.kind !== "good" && preview.kind !== "note") return null;
  if (preview.source !== "user" && preview.source !== "claude-code" && preview.source !== "codex") return null;
  return {
    id: preview.id,
    kind: preview.kind,
    note: typeof preview.note === "string" ? preview.note : null,
    source: preview.source,
    span_id: typeof preview.span_id === "string" ? preview.span_id : null,
    created_at: typeof preview.created_at === "number" ? preview.created_at : Date.now(),
  };
}

function annotationKindLabel(kind: SavedAnnotationPreview["kind"]): string {
  if (kind === "issue") return "Issue";
  if (kind === "good") return "Good";
  return "Note";
}

// Server-backed (`/api/saved-runs`) so saves are visible across browsers
// hitting the same workshop daemon. The module keeps a synchronous cache
// so callers like RunDetail / RunList / SearchPage stay synchronous.

const LEGACY_EVENTS_KEY = "rd_saved_events";
const LEGACY_FOLDERS_KEY = "rd_saved_folders";
const LEGACY_COLORS_KEY = "rd_folder_colors";
const LEGACY_MIGRATED_KEY = "rd_saved_migrated_v1";
const REFRESH_EVENT = "rd_saved_updated";

interface FolderEntry { name: string; color: string }

interface CacheState {
  loaded: boolean;
  events: SavedEvent[];
  folders: FolderEntry[];
}

const state: CacheState = { loaded: false, events: [], folders: [] };
let loadPromise: Promise<void> | null = null;

function notify() {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

function applyServerPayload(payload: { events?: any[]; folders?: any[] }) {
  if (Array.isArray(payload.events)) {
    state.events = payload.events.map((e: any): SavedEvent => ({
      id: String(e.id),
      event_name: String(e.event_name ?? ""),
      user_id: e.user_id ?? null,
      convo_id: e.convo_id ?? null,
      timestamp: String(e.timestamp ?? ""),
      user_input: e.user_input ?? null,
      assistant_output: e.assistant_output ?? null,
      signals: Array.isArray(e.signals) ? e.signals : undefined,
      properties: e.properties && typeof e.properties === "object" ? e.properties : undefined,
      saved_at: typeof e.saved_at === "number" ? e.saved_at : Date.now(),
      summary: typeof e.summary === "string" ? e.summary : undefined,
      source: e.source === "cloud" || e.source === "local" ? e.source : undefined,
      folder: typeof e.folder === "string" && e.folder ? e.folder : undefined,
    })).sort((a, b) => b.saved_at - a.saved_at);
  }
  if (Array.isArray(payload.folders)) {
    state.folders = payload.folders
      .filter((f: any) => f && typeof f.name === "string" && typeof f.color === "string")
      .map((f: any): FolderEntry => ({ name: f.name, color: f.color }));
  }
}

async function migrateLegacyLocalStorage(): Promise<boolean> {
  try {
    if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return false;
    const rawEvents = localStorage.getItem(LEGACY_EVENTS_KEY);
    const rawFolders = localStorage.getItem(LEGACY_FOLDERS_KEY);
    const rawColors = localStorage.getItem(LEGACY_COLORS_KEY);
    if (!rawEvents && !rawFolders) {
      localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
      return false;
    }
    let events: any[] = [];
    let folders: string[] = [];
    let colors: Record<string, string> = {};
    try { events = rawEvents ? JSON.parse(rawEvents) : []; } catch {}
    try { folders = rawFolders ? JSON.parse(rawFolders) : []; } catch {}
    try { colors = rawColors ? JSON.parse(rawColors) : {}; } catch {}

    const folderSet = new Set<string>(folders.filter(f => typeof f === "string"));
    for (const e of events) if (typeof e?.folder === "string" && e.folder) folderSet.add(e.folder);

    await Promise.all([...folderSet].map(name =>
      fetch("/api/saved-runs/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color: colors[name] }),
      }).catch(() => null)
    ));

    const validEvents = events.filter((e: any) => e?.id && typeof e.id === "string");
    await Promise.all(validEvents.map((e: any) =>
      fetch(`/api/saved-runs/events/${encodeURIComponent(e.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(e),
      }).catch(() => null)
    ));

    localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

async function loadFromServer(): Promise<void> {
  try {
    const res = await fetch("/api/saved-runs");
    if (!res.ok) return;
    const data = await res.json();
    applyServerPayload(data);
    state.loaded = true;
  } catch {
    // Server unreachable — leave cache empty; next mutation will retry.
  }
}

async function ensureLoaded(): Promise<void> {
  if (state.loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const migrated = await migrateLegacyLocalStorage();
    await loadFromServer();
    if (migrated) notify();
  })();
  return loadPromise;
}

// Kick off the load eagerly so consumers that read synchronously after a
// short delay (e.g. user opening the Save popover) see populated data.
ensureLoaded().catch(() => {});

export function getSavedEvents(): SavedEvent[] {
  if (!state.loaded) ensureLoaded().then(notify).catch(() => {});
  return state.events.slice();
}

export function getFolders(): string[] {
  if (!state.loaded) ensureLoaded().then(notify).catch(() => {});
  return state.folders.map(f => f.name);
}

export function getFolderColors(): Record<string, string> {
  return Object.fromEntries(state.folders.map(f => [f.name, f.color]));
}

export function getFolderColor(folder: string): string {
  const existing = state.folders.find(f => f.name === folder);
  if (existing) return existing.color;
  // Optimistic placeholder; server will assign the real color on POST.
  // Use a stable fallback so the UI doesn't flicker.
  return "#9ca3af";
}

export function addFolder(name: string) {
  if (!name) return;
  if (!state.folders.some(f => f.name === name)) {
    state.folders = [...state.folders, { name, color: "#9ca3af" }];
    notify();
  }
  fetch("/api/saved-runs/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.folder) {
        state.folders = state.folders.map(f => f.name === data.folder.name ? { name: data.folder.name, color: data.folder.color } : f);
        notify();
      }
    })
    .catch(() => {});
}

export function removeFolder(name: string) {
  state.folders = state.folders.filter(f => f.name !== name);
  state.events = state.events.map(e => e.folder === name ? { ...e, folder: undefined } : e);
  notify();
  fetch(`/api/saved-runs/folders/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});
}

export function saveEvent(event: SavedEvent) {
  if (state.events.some(e => e.id === event.id)) return;
  state.events = [event, ...state.events];
  if (event.folder && !state.folders.some(f => f.name === event.folder)) {
    state.folders = [...state.folders, { name: event.folder, color: "#9ca3af" }];
  }
  notify();
  fetch(`/api/saved-runs/events/${encodeURIComponent(event.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  })
    .then(r => r.ok ? r.json() : null)
    .then(() => loadFromServer().then(notify))
    .catch(() => {});
  summarizeAndUpdate(event).catch(() => {});
}

export function removeSavedEvent(id: string) {
  state.events = state.events.filter(e => e.id !== id);
  notify();
  fetch(`/api/saved-runs/events/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  fetch(`/api/saved-runs/cache/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

export function updateSavedEvent(id: string, patch: Partial<SavedEvent>) {
  const idx = state.events.findIndex(e => e.id === id);
  if (idx === -1) return;
  state.events = state.events.map((e, i) => i === idx ? { ...e, ...patch } : e);
  if (patch.folder && !state.folders.some(f => f.name === patch.folder)) {
    state.folders = [...state.folders, { name: patch.folder, color: "#9ca3af" }];
  }
  notify();
  // JSON.stringify drops keys with undefined values, so an explicit "unfile"
  // (folder=undefined in the patch) would silently no-op on the server. Send
  // null in that case so the PATCH endpoint clears the folder column.
  const serverPatch: Record<string, unknown> = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "folder") && patch.folder == null) {
    serverPatch.folder = null;
  }
  fetch(`/api/saved-runs/events/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serverPatch),
  })
    .then(r => r.ok ? r.json() : null)
    .then(() => loadFromServer().then(notify))
    .catch(() => {});
}

export function isEventSaved(id: string): boolean {
  if (!state.loaded) ensureLoaded().then(notify).catch(() => {});
  return state.events.some(e => e.id === id);
}

const FILTERS_KEY = "rd_saved_filters_v1";

export interface SavedFilters {
  search: string;
  folder: string | null;     // null = all, "" = unfiled
  agent: string;             // "" = all
  source: "all" | "local" | "cloud";
}

const DEFAULT_FILTERS: SavedFilters = {
  search: "",
  folder: null,
  agent: "",
  source: "all",
};

function loadFilters(): SavedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      folder: parsed.folder === null || typeof parsed.folder === "string" ? parsed.folder : null,
      agent: typeof parsed.agent === "string" ? parsed.agent : "",
      source: parsed.source === "local" || parsed.source === "cloud" ? parsed.source : "all",
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function useFilters() {
  const [filters, setFilters] = useState<SavedFilters>(loadFilters);
  useEffect(() => {
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch {
      // localStorage may be disabled (private browsing); filters just won't persist.
    }
  }, [filters]);
  const update = useCallback((patch: Partial<SavedFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }));
  }, []);
  const reset = useCallback(() => setFilters(DEFAULT_FILTERS), []);
  const resetSecondary = useCallback(
    () => setFilters(prev => ({ ...prev, agent: "", source: "all" })),
    [],
  );
  return { filters, update, reset, resetSecondary };
}

function FolderPills({ folders, selected, onSelect, onCreate, onDelete }: {
  folders: string[];
  selected: string | null;
  onSelect: (folder: string | null) => void;
  onCreate: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = window.setTimeout(() => setConfirmDelete(null), 2500);
    return () => window.clearTimeout(t);
  }, [confirmDelete]);

  const submitNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) { setShowNew(false); return; }
    onCreate(trimmed);
    setNewName("");
    setShowNew(false);
  };

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto sb"
      style={{ scrollbarWidth: "none" }}
      onWheel={(e) => {
        if (e.deltaY !== 0 && e.deltaX === 0) {
          e.currentTarget.scrollLeft += e.deltaY;
        }
      }}
      data-testid="folder-pills"
    >
      <button
        className="shrink-0 px-2 py-0.5 rounded text-[10px] transition-colors"
        style={{ background: selected === null ? "rgba(255,255,255,0.08)" : "transparent", color: selected === null ? C.fg3 : C.fg0 }}
        onClick={() => onSelect(null)}
      >All</button>
      {folders.map(f => {
        const fc = getFolderColor(f);
        const isActive = selected === f;
        const isConfirming = confirmDelete === f;
        return (
          <div key={f} className="relative shrink-0 flex items-center">
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors"
              style={{ background: isActive ? "rgba(255,255,255,0.08)" : "transparent", color: isActive ? C.fg3 : C.fg0 }}
              onClick={() => onSelect(isActive ? null : f)}
            >
              <div className="w-2 h-2 rounded-full" style={{ background: fc }} />
              {f}
              {isActive && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={isConfirming ? `Confirm delete folder ${f}` : `Delete folder ${f}`}
                  className="ml-0.5 px-1 -mr-1 rounded hover:bg-white/10"
                  style={{ color: isConfirming ? "#ff7a7a" : C.fg0 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isConfirming) { onDelete(f); setConfirmDelete(null); }
                    else { setConfirmDelete(f); }
                  }}
                  title={isConfirming ? "Click again to confirm" : "Delete folder"}
                >{isConfirming ? "✓" : "×"}</span>
              )}
            </button>
          </div>
        );
      })}
      {showNew ? (
        <input
          autoFocus
          className="shrink-0 px-1.5 py-0.5 rounded text-[10px] outline-none w-24"
          style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.1)" }}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onBlur={submitNew}
          onKeyDown={e => {
            if (e.key === "Enter") submitNew();
            if (e.key === "Escape") { setNewName(""); setShowNew(false); }
          }}
          placeholder="Folder name…"
          aria-label="New folder name"
        />
      ) : (
        <button
          className="shrink-0 px-1.5 py-0.5 rounded text-[10px] transition-colors hover:bg-white/[0.06]"
          style={{ color: C.fg0 }}
          aria-label="Add folder"
          onClick={() => setShowNew(true)}
        ><FolderPlus className="h-3 w-3" /></button>
      )}
    </div>
  );
}

function FilterBar({ filters, agents, onUpdate, onResetSecondary }: {
  filters: SavedFilters;
  agents: string[];
  onUpdate: (patch: Partial<SavedFilters>) => void;
  onResetSecondary: () => void;
}) {
  const [popOpen, setPopOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const activeCount = (filters.agent ? 1 : 0) + (filters.source !== "all" ? 1 : 0);

  useEffect(() => {
    if (!popOpen) return;
    const h = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setPopOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [popOpen]);

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex-1 min-w-0">
        <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 pointer-events-none" style={{ color: C.fg0 }} />
        <input
          aria-label="Search saved runs"
          className="w-full pl-6 pr-6 py-1 rounded text-[11px] outline-none"
          style={{ background: "rgba(255,255,255,0.04)", color: C.fg3, border: "1px solid rgba(255,255,255,0.06)" }}
          placeholder="Search saved runs…"
          value={filters.search}
          onChange={e => onUpdate({ search: e.target.value })}
        />
        {filters.search && (
          <button
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10"
            style={{ color: C.fg0 }}
            onClick={() => onUpdate({ search: "" })}
          ><X className="h-2.5 w-2.5" /></button>
        )}
      </div>
      <button
        ref={btnRef}
        aria-label="Open filters"
        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
        style={{
          background: activeCount > 0 ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
          color: activeCount > 0 ? C.fg3 : C.fg2,
          border: "1px solid rgba(255,255,255,0.06)",
        }}
        onClick={() => setPopOpen(v => !v)}
      >
        <SlidersHorizontal className="h-3 w-3" />
        Filters{activeCount > 0 ? ` · ${activeCount}` : ""}
      </button>
      {popOpen && (
        <div
          ref={(el) => {
            (popRef as any).current = el;
            if (!el || !btnRef.current) return;
            const r = btnRef.current.getBoundingClientRect();
            el.style.top = `${r.bottom + 4}px`;
            el.style.right = `${window.innerWidth - r.right}px`;
          }}
          className="fixed z-[9999] rounded-lg p-2.5 shadow-xl space-y-2"
          style={{ background: "rgba(20,20,20,0.92)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.12)", width: 220 }}
        >
          <div>
            <div className="text-[10px] mb-1" style={{ color: C.fg0 }}>Agent</div>
            <div className="relative">
              <select
                aria-label="Filter by agent"
                className="w-full appearance-none pl-2 pr-5 py-1 rounded text-[11px] outline-none cursor-pointer"
                style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.08)" }}
                value={filters.agent}
                onChange={e => onUpdate({ agent: e.target.value })}
              >
                <option value="">All agents</option>
                {agents.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 pointer-events-none" style={{ color: C.fg0 }} />
            </div>
          </div>
          <div>
            <div className="text-[10px] mb-1" style={{ color: C.fg0 }}>Source</div>
            <div role="radiogroup" aria-label="Filter by source" className="flex rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
              {(["all", "local", "cloud"] as const).map(opt => (
                <button
                  key={opt}
                  role="radio"
                  aria-checked={filters.source === opt}
                  className="flex-1 py-1 text-[10px] transition-colors"
                  style={{
                    background: filters.source === opt ? "rgba(255,255,255,0.1)" : "transparent",
                    color: filters.source === opt ? C.fg3 : C.fg1,
                  }}
                  onClick={() => onUpdate({ source: opt })}
                >{opt === "all" ? "All" : opt === "local" ? "Local" : "Prod"}</button>
              ))}
            </div>
          </div>
          {activeCount > 0 && (
            <button
              className="w-full text-[10px] py-1 rounded transition-colors hover:bg-white/[0.06]"
              style={{ color: C.fg0 }}
              onClick={onResetSecondary}
            >Reset</button>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveFilterChips({ filters, onUpdate }: {
  filters: SavedFilters;
  onUpdate: (patch: Partial<SavedFilters>) => void;
}) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.search) chips.push({ key: "search", label: `"${filters.search}"`, clear: () => onUpdate({ search: "" }) });
  if (filters.agent) chips.push({ key: "agent", label: `Agent: ${filters.agent}`, clear: () => onUpdate({ agent: "" }) });
  if (filters.source !== "all") chips.push({ key: "source", label: `Source: ${filters.source === "local" ? "Local" : "Prod"}`, clear: () => onUpdate({ source: "all" }) });
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap" data-testid="active-filter-chips">
      {chips.map(c => (
        <button
          key={c.key}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] transition-colors hover:bg-white/[0.06]"
          style={{ background: "rgba(255,255,255,0.04)", color: C.fg2, border: "1px solid rgba(255,255,255,0.08)" }}
          onClick={c.clear}
          aria-label={`Clear ${c.key} filter`}
        >
          {c.label}
          <X className="h-2.5 w-2.5" />
        </button>
      ))}
    </div>
  );
}

export function SavePopover({ onSave, onClose, anchorRef, currentFolder, onUnsave }: {
  onSave: (folder?: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** When provided, the popover highlights the run's current folder (null/undefined = Unfiled) and switches its header to "Move to folder". */
  currentFolder?: string | null;
  /** When provided, renders a destructive "Remove from saved" row at the bottom. */
  onUnsave?: () => void;
}) {
  // Subscribe to the saved-runs refresh event so the popover surfaces
  // folders that were created/loaded after it mounted (e.g. when the
  // server-backed cache finishes its initial load).
  const [folders, setFolders] = useState<string[]>(() => getFolders());
  const [newFolder, setNewFolder] = useState("");
  const [showNew, setShowNew] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  // `currentFolder` is undefined only on the initial save flow (the run is
  // not yet saved). Once a folder is being moved, the caller passes
  // `currentFolder` (`null` for Unfiled or a folder name) and we switch the
  // header + create-button copy to "Move".
  const isSaved = currentFolder !== undefined;
  const normalizedCurrent = currentFolder ?? null;

  useEffect(() => {
    const refresh = () => setFolders(getFolders());
    refresh();
    window.addEventListener("rd_saved_updated", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("rd_saved_updated", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, anchorRef]);

  const renderFolderRow = (label: string, value: string | null, icon: React.ReactNode) => {
    const selected = normalizedCurrent === value;
    return (
      <button
        key={value ?? "__unfiled"}
        className="w-full text-left px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 transition-colors hover:bg-white/[0.06]"
        style={{
          color: selected ? C.fg5 : C.fg3,
          background: selected ? "rgba(255,255,255,0.05)" : "transparent",
        }}
        onClick={() => { onSave(value ?? undefined); onClose(); }}
      >
        {icon}
        <span className="flex-1 truncate">{label}</span>
        {selected && <Check className="h-3 w-3" style={{ color: C.green }} />}
      </button>
    );
  };

  return (
    <div
      ref={(el) => {
        (popRef as any).current = el;
        if (!el || !anchorRef.current) return;
        const btn = anchorRef.current.getBoundingClientRect();
        el.style.top = `${btn.bottom + 4}px`;
        el.style.right = `${window.innerWidth - btn.right}px`;
      }}
      className="fixed z-[9999] rounded-lg p-2.5 shadow-xl space-y-1"
      style={{ background: "rgba(20,20,20,0.85)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)", width: 220 }}
    >
      <div className="text-[10px] px-2 py-1" style={{ color: C.fg0 }}>
        {isSaved ? "Move to folder" : "Save to folder"}
      </div>
      {renderFolderRow("Unfiled", null, <Folder className="h-3 w-3" style={{ color: C.fg0 }} />)}
      {folders.map(f => renderFolderRow(
        f,
        f,
        <div className="w-2 h-2 rounded-full shrink-0 ml-0.5" style={{ background: getFolderColor(f) }} />,
      ))}
      {showNew ? (
        <div className="flex gap-1">
          <input autoFocus className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] outline-none" style={{ background: "rgba(255,255,255,0.06)", color: C.fg3, border: "1px solid rgba(255,255,255,0.1)" }}
            placeholder="Folder name..." value={newFolder} onChange={e => setNewFolder(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && newFolder.trim()) { addFolder(newFolder.trim()); onSave(newFolder.trim()); onClose(); } }} />
          <button className="px-2 py-1 rounded text-[10px] font-medium" style={{ background: "rgba(255,255,255,0.08)", color: C.fg3 }}
            onClick={() => { if (newFolder.trim()) { addFolder(newFolder.trim()); onSave(newFolder.trim()); onClose(); } }}>
            {isSaved ? "Move" : "Save"}
          </button>
        </div>
      ) : (
        <button className="w-full text-left px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 transition-colors hover:bg-white/[0.06]" style={{ color: C.fg0 }}
          onClick={() => setShowNew(true)}>
          <FolderPlus className="h-3 w-3" /> New folder...
        </button>
      )}
      {onUnsave && (
        <>
          <div className="my-1 -mx-1.5 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }} />
          <button className="w-full text-left px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 transition-colors"
            style={{ color: "#ff7a7a" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,107,107,0.1)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            onClick={() => { onUnsave(); onClose(); }}>
            <Trash2 className="h-3 w-3" /> Remove from saved
          </button>
        </>
      )}
    </div>
  );
}

async function summarizeAndUpdate(event: SavedEvent): Promise<void> {
  try {
    const content = [
      `Event: ${event.event_name}`,
      event.user_input ? `User: ${event.user_input.slice(0, 1500)}` : null,
      event.assistant_output ? `Assistant: ${event.assistant_output.slice(0, 1500)}` : null,
      event.signals?.length ? `Signals: ${event.signals.map(s => s.name).join(", ")}` : null,
    ].filter(Boolean).join("\n\n");

    const apiKey = localStorage.getItem("rd_api_key") ?? undefined;
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, apiKey }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.summary) {
      updateSavedEvent(event.id, { summary: data.summary });
      window.dispatchEvent(new Event("rd_saved_updated"));
    }
  } catch { /* silently fail */ }
}

export function SavedPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? decodeURIComponent(routeRunId) : null;
  const [events, setEvents] = useState<SavedEvent[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const { filters, update, resetSecondary } = useFilters();

  const reload = useCallback(() => { setEvents(getSavedEvents()); setFolders(getFolders()); }, []);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const handler = () => reload();
    window.addEventListener("storage", handler);
    window.addEventListener("rd_saved_updated", handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("rd_saved_updated", handler);
    };
  }, [reload]);

  const agentNames = useMemo(() => [...new Set(events.map(e => e.event_name))].sort(), [events]);

  const filtered = useMemo(() => {
    let result = events;
    if (filters.folder !== null) result = result.filter(e => (e.folder ?? "") === filters.folder);
    if (filters.agent) result = result.filter(e => e.event_name === filters.agent);
    if (filters.source !== "all") result = result.filter(e => (e.source ?? "local") === filters.source);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(e =>
        (e.summary ?? "").toLowerCase().includes(q) ||
        (e.user_input ?? "").toLowerCase().includes(q) ||
        (e.assistant_output ?? "").toLowerCase().includes(q) ||
        (getSavedAnnotationPreview(e)?.note ?? "").toLowerCase().includes(q) ||
        (e.event_name ?? "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [events, filters]);

  const selectedEvent = useMemo(() => events.find(e => e.id === selectedId) ?? null, [events, selectedId]);

  const handleRemove = (id: string) => {
    removeSavedEvent(id);
    if (selectedId === id) navigate("/saved", { replace: true });
    reload();
  };

  const handleCreateFolder = (name: string) => {
    addFolder(name);
    update({ folder: name });
    reload();
  };

  const handleDeleteFolder = (name: string) => {
    removeFolder(name);
    if (filters.folder === name) update({ folder: null });
    reload();
  };

  const isEmpty = events.length === 0;

  return (
    <div className="h-full flex relative">

      <div className={`w-80 flex-shrink-0 flex flex-col ${isEmpty ? "opacity-40 pointer-events-none" : ""}`} style={{ borderRight: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="p-3 space-y-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center justify-between">
            <div className="text-[14px]" style={{ fontFamily: '"AlphaLyrae", sans-serif', color: C.fg3 }}>Saved Runs</div>
            <div className="text-[10px]" style={{ color: C.fg0 }}>
              {filtered.length === events.length ? String(events.length) : `${filtered.length}/${events.length}`}
            </div>
          </div>

          <FilterBar
            filters={filters}
            agents={agentNames}
            onUpdate={update}
            onResetSecondary={resetSecondary}
          />

          <FolderPills
            folders={folders}
            selected={filters.folder}
            onSelect={(f) => update({ folder: f })}
            onCreate={handleCreateFolder}
            onDelete={handleDeleteFolder}
          />

          <ActiveFilterChips filters={filters} onUpdate={update} />
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-0.5 sb">
          {filtered.map(evt => (
            <SavedListItem
              key={evt.id}
              event={evt}
              selected={selectedId === evt.id}
              onClick={() => navigate(tracePath("/saved", evt.id))}
              onRemove={() => handleRemove(evt.id)}
              onMove={(folder) => { updateSavedEvent(evt.id, { folder }); if (folder) addFolder(folder); reload(); }}
            />
          ))}
        </div>
      </div>


      <div className={`flex-1 min-w-0 overflow-hidden ${isEmpty ? "opacity-40" : ""}`}>
        {selectedEvent && <SavedRunDetail key={selectedEvent.id} event={selectedEvent} />}
        {!selectedEvent && !isEmpty && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-2">
              <Bookmark className="mx-auto h-6 w-6" style={{ color: C.fg0 }} />
              <div className="text-[11px]" style={{ color: C.fg0 }}>Select a saved event to view its trace</div>
            </div>
          </div>
        )}
      </div>


      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <div className="text-center space-y-3 max-w-xs px-4 py-6 rounded-xl" style={{ background: "rgba(0,0,0,0.8)", border: "1px solid rgba(255,255,255,0.1)" }}>
            <Bookmark className="mx-auto h-8 w-8" style={{ color: C.fg1 }} />
            <div className="text-sm font-medium" style={{ color: C.fg3 }}>No Saved Runs</div>
            <div className="text-[11px] leading-relaxed" style={{ color: C.fg1 }}>
              Save runs from the Runs page to collect them here for later reference.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SavedListItem({ event, selected, onClick, onRemove, onMove }: {
  event: SavedEvent; selected: boolean; onClick: () => void; onRemove: () => void; onMove: (folder: string | undefined) => void;
}) {
  const ts = new Date(event.timestamp);
  const timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
    ts.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const moveBtnRef = useRef<HTMLButtonElement>(null);
  const confirmTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!confirmRemove) return;
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = window.setTimeout(() => setConfirmRemove(false), 2500);
    return () => { if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current); };
  }, [confirmRemove]);

  const folderColor = event.folder ? getFolderColor(event.folder) : null;
  const annotationPreview = getSavedAnnotationPreview(event);
  const titleText = event.summary || event.user_input || "";
  const titleColor = event.summary ? C.fg4 : (event.user_input ? C.fg1 : C.fg0);

  return (
    <div className="group relative">
      <button
        className="w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150"
        style={{
          background: selected ? "rgba(255,255,255,0.08)" : "transparent",
          border: selected ? "1px solid rgba(255,255,255,0.15)" : "1px solid transparent",
        }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "rgba(255,255,255,0.08)" : "transparent"; }}
        onClick={onClick}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="text-[12px] leading-snug line-clamp-2 min-h-[32px]" style={{ color: titleColor }}>
            {titleText || "No summary yet"}
          </div>
          {annotationPreview && (
            <div className="mt-1.5 flex min-w-0 items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-snug"
              style={{ background: "rgba(255,255,255,0.04)", color: C.fg2, border: "1px solid rgba(255,255,255,0.06)" }}>
              <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0" style={{ color: C.fg1 }} />
              <span className="line-clamp-2">
                {annotationPreview.note
                  ? `${annotationKindLabel(annotationPreview.kind)}: ${annotationPreview.note}`
                  : `${annotationKindLabel(annotationPreview.kind)} annotation`}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-1.5 overflow-hidden">
            {event.folder && (
              <span className="text-[9px] font-medium px-1.5 py-px rounded-full shrink-0 flex items-center gap-1"
                style={{ background: `${folderColor}18`, color: folderColor!, border: `1px solid ${folderColor}40` }}>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: folderColor! }} />
                {event.folder}
              </span>
            )}
            <span className="text-[10px] font-medium px-1.5 py-px rounded-full shrink-0" style={
              event.source === "cloud"
                ? { background: "rgba(255,255,255,0.12)", color: "#fff", border: "1px solid rgba(255,255,255,0.25)" }
                : { background: "transparent", color: C.fg3, border: "1px solid rgba(255,255,255,0.28)" }
            }>
              {event.source === "cloud" ? "Prod" : "Local"}
            </span>
            <span className="text-[10px] truncate" style={{ color: C.fg0 }}>{event.event_name}</span>
            <span className="text-[9px] flex-shrink-0 ml-auto" style={{ color: C.fg0 }}>{timeStr}</span>
          </div>
        </div>
      </button>
      {/* Right-edge fade: covers the text behind the action icons on hover so they don't visually collide with text */}
      <div
        className="pointer-events-none absolute top-1 bottom-1 right-1 w-20 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity rounded-r-lg"
        style={{
          background: "linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 55%, rgba(0,0,0,1) 100%)",
        }}
      />
      {/* Action column: overlays the faded right edge */}
      <div className="absolute top-1/2 -translate-y-1/2 right-1.5 z-10 flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          ref={moveBtnRef}
          className="p-1 rounded transition-colors hover:bg-white/10"
          style={{ color: C.fg2 }}
          onClick={(e) => { e.stopPropagation(); setConfirmRemove(false); setMoveOpen(v => !v); }}
          title="Move to folder"
        >
          <Folder className="h-3 w-3" />
        </button>
        <button
          className="p-1 rounded transition-colors"
          style={{
            color: confirmRemove ? "#ff7a7a" : C.fg2,
            background: confirmRemove ? "rgba(255,107,107,0.16)" : "transparent",
          }}
          onMouseEnter={(e) => { if (!confirmRemove) e.currentTarget.style.background = "rgba(255,255,255,0.1)"; }}
          onMouseLeave={(e) => { if (!confirmRemove) e.currentTarget.style.background = "transparent"; }}
          onClick={(e) => {
            e.stopPropagation();
            if (confirmRemove) { setConfirmRemove(false); onRemove(); }
            else { setConfirmRemove(true); setMoveOpen(false); }
          }}
          title={confirmRemove ? "Click again to confirm delete" : "Remove"}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {moveOpen && (
        <SavePopover
          anchorRef={moveBtnRef as React.RefObject<HTMLElement | null>}
          onClose={() => setMoveOpen(false)}
          currentFolder={event.folder ?? null}
          onSave={(folder) => onMove(folder)}
        />
      )}
    </div>
  );
}

function SavedRunDetail({ event }: { event: SavedEvent }) {
  const [hasLocalRun, setHasLocalRun] = useState<boolean | null>(null);

  useEffect(() => {
    setHasLocalRun(null);
    fetch(`/api/runs/detail/${event.id}`)
      .then(r => {
        if (!r.ok) return null;
        return r.json();
      })
      .then(data => {
        if (data?.run && data?.spans?.length > 0) {
          // Cache to server for future use (survives clears)
          fetch(`/api/saved-runs/cache/${event.id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "local", run: data.run, spans: data.spans, liveEvents: data.liveEvents, subAgents: data.subAgents }),
          }).catch(() => {});
          setHasLocalRun(true);
        } else {
          setHasLocalRun(false);
        }
      })
      .catch(() => setHasLocalRun(false));
  }, [event.id]);

  if (hasLocalRun === null) {
    return <div className="h-full flex items-center justify-center gap-2" style={{ color: C.fg1 }}>
      <Loader2 className="h-4 w-4 animate-spin" /> Loading...
    </div>;
  }

  if (hasLocalRun) {
    return (
      <div className="h-full overflow-auto sb">
        <RunDetail runId={event.id} routeBase="/saved" />
      </div>
    );
  }

  // Cloud event — try loading via Query API (checks server cache first)
  return <CloudTraceDetail event={event} />;
}

// Inline cloud trace viewer — same as RemoteRunDetail in SearchPage but standalone
import type { Span, SubAgent } from "../utils/types";

const API_BASE = "https://query.raindrop.ai";

interface TraceSpan {
  trace_id: string; span_id: string; parent_span_id: string | null;
  span_name: string; span_type: string; status: string;
  start_time_ns: number; end_time_ns: number; duration_ns: number;
  input: string | null; output: string | null;
  input_tokens: number | null; output_tokens: number | null;
  model: string | null; provider: string | null;
  attributes: Record<string, string | number>;
}

async function fetchCloudTraces(eventId: string): Promise<TraceSpan[]> {
  const key = localStorage.getItem("rd_query_key");
  if (!key) throw new Error("No Query API key.");
  const url = new URL("/v1/traces", API_BASE);
  url.searchParams.set("event_id", eventId);
  url.searchParams.set("limit", "500");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.data;
}

function mapTraceToSpans(traces: TraceSpan[], eventId: string): Span[] {
  return traces.map(t => {
    let inputPayload = t.input;
    let outputPayload = t.output;
    if (t.span_type.includes("LLM")) {
      const aiPrompt = t.attributes["ai.prompt"] as string | undefined;
      if (aiPrompt) inputPayload = aiPrompt;
      const aiResponseText = t.attributes["ai.response.text"] as string | undefined;
      if (aiResponseText && !outputPayload) outputPayload = aiResponseText;
    }
    return {
      id: t.span_id, run_id: eventId, parent_span_id: t.parent_span_id,
      name: t.span_name, span_type: t.span_type, status: t.status,
      input_payload: inputPayload, output_payload: outputPayload,
      start_time_ms: t.start_time_ns / 1e6, end_time_ms: t.end_time_ns / 1e6,
      duration_ms: t.duration_ns / 1e6, model: t.model, provider: t.provider,
      input_tokens: t.input_tokens, output_tokens: t.output_tokens,
      attributes: Object.keys(t.attributes).length > 0 ? JSON.stringify(t.attributes) : null,
    };
  });
}

function detectSubAgentsFromSpans(spans: Span[]): SubAgent[] {
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
    let hasAgenticLoop = false;
    for (const llm of kids.filter(k => k.span_type?.includes("LLM"))) {
      const gk = children.get(llm.id) ?? [];
      if (gk.some(g => g.span_type === "TOOL_CALL") || llm.name === "agent.subagent") { hasAgenticLoop = true; break; }
    }
    if (!hasAgenticLoop) continue;
    const collected = new Set<string>();
    const allIds: string[] = [];
    let llmCount = 0, toolCount = 0, totalIn = 0, totalOut = 0, model: string | null = null;
    function collect(id: string) {
      if (collected.has(id)) return;
      collected.add(id); allIds.push(id);
      const s = spanMap.get(id);
      if (s?.span_type?.includes("LLM")) { llmCount++; if (!model && s.model) model = s.model; totalIn += s.input_tokens ?? 0; totalOut += s.output_tokens ?? 0; }
      if (s?.span_type === "TOOL_CALL" && s.id !== span.id) toolCount++;
      for (const kid of children.get(id) ?? []) collect(kid.id);
    }
    collect(span.id);
    agents.push({ root_span_id: span.id, name: span.name, span_ids: allIds, start_time_ms: span.start_time_ms, end_time_ms: span.end_time_ms, duration_ms: span.duration_ms, model, status: span.status, llm_count: llmCount, tool_count: toolCount, total_input_tokens: totalIn, total_output_tokens: totalOut });
  }
  return agents;
}

function CloudTraceDetail({ event }: { event: SavedEvent }) {
  const [spans, setSpans] = useState<Span[]>([]);
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setError(null);

    // Try server cache first, then cloud API
    fetch(`/api/saved-runs/cache/${event.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(cached => {
        if (cached?.type === "cloud" && cached.spans) {
          setSpans(cached.spans);
          setSubAgents(detectSubAgentsFromSpans(cached.spans));
          setLoading(false);
          return;
        }
        return fetchCloudTraces(event.id).then(traces => {
          const m = mapTraceToSpans(traces, event.id);
          setSpans(m); setSubAgents(detectSubAgentsFromSpans(m));
          // Cache to server
          fetch(`/api/saved-runs/cache/${event.id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "cloud", spans: m }),
          }).catch(() => {});
        });
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [event.id]);

  if (loading) return <div className="h-full flex items-center justify-center gap-2" style={{ color: C.fg1 }}><Loader2 className="h-4 w-4 animate-spin" /> Loading trace...</div>;
  if (error) return <div className="h-full flex items-center justify-center"><div className="text-[11px]" style={{ color: C.red }}>{error}</div></div>;
  if (spans.length === 0) return <div className="h-full flex items-center justify-center"><div className="text-[11px]" style={{ color: C.fg0 }}>No trace data</div></div>;

  const startMs = Math.min(...spans.map(s => s.start_time_ms));
  const endMs = Math.max(...spans.map(s => s.end_time_ms));
  const run: Run = {
    id: event.id,
    name: null,
    event_name: event.event_name,
    user_id: event.user_id,
    convo_id: event.convo_id,
    started_at: startMs,
    last_updated_at: endMs,
    metadata: null,
    model: spans.find(s => s.model)?.model ?? null,
    finished: 1,
  };

  return (
    <div className="h-full overflow-auto sb">
      <RunDetail
        runId={event.id}
        routeBase="/saved"
        source="cloud"
        initialData={{ run, spans, liveEvents: [], subAgents }}
      />
    </div>
  );
}

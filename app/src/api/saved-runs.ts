import { useSyncExternalStore } from "react";
import { z } from "zod";
import { apiJson, apiJsonOrNull, jsonInit } from "./request";
import type { LiveEvent, Run, Span, SubAgent } from "../utils/types";

const LEGACY_EVENTS_KEY = "rd_saved_events";
const LEGACY_FOLDERS_KEY = "rd_saved_folders";
const LEGACY_COLORS_KEY = "rd_folder_colors";
const LEGACY_MIGRATED_KEY = "rd_saved_migrated_v1";
export const SAVED_RUNS_REFRESH_EVENT = "rd_saved_updated";

const optionalStringSchema = z.preprocess(
  value => typeof value === "string" && value.length > 0 ? value : undefined,
  z.string().optional(),
);

const nullableStringSchema = z.preprocess(
  value => typeof value === "string" ? value : null,
  z.string().nullable(),
);

const savedSignalSchema = z.object({
  id: z.string(),
  name: z.string(),
  score: z.number().optional(),
});

type SavedSignal = z.infer<typeof savedSignalSchema>;

const savedSignalsSchema = z.array(
  z.unknown().transform(value => {
    const parsed = savedSignalSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }),
).transform(signals => signals.filter((signal): signal is SavedSignal => signal !== null));

const savedEventSchema = z.object({
  id: z.string(),
  event_name: z.preprocess(value => typeof value === "string" ? value : "", z.string()),
  user_id: nullableStringSchema,
  convo_id: nullableStringSchema,
  timestamp: z.preprocess(value => typeof value === "string" ? value : "", z.string()),
  user_input: nullableStringSchema,
  assistant_output: nullableStringSchema,
  signals: z.preprocess(value => value ?? undefined, savedSignalsSchema.optional()),
  saved_at: z.number().catch(() => Date.now()),
  summary: optionalStringSchema,
  source: z.enum(["local", "cloud"]).optional().catch(undefined),
  folder: optionalStringSchema,
});

export type SavedEvent = z.infer<typeof savedEventSchema>;

const folderEntrySchema = z.object({
  name: z.string(),
  color: z.string(),
});

type FolderEntry = z.infer<typeof folderEntrySchema>;

const savedRunsPayloadSchema = z.object({
  events: z.array(z.unknown()).optional(),
  folders: z.array(z.unknown()).optional(),
});

const spanCacheSchema: z.ZodType<Span> = z.object({
  id: z.string(),
  run_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  span_type: z.string().nullable(),
  status: z.string(),
  input_payload: z.string().nullable(),
  output_payload: z.string().nullable(),
  start_time_ms: z.number(),
  end_time_ms: z.number(),
  duration_ms: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  attributes: z.string().nullable(),
  normalized: z.custom<Span["normalized"]>().optional(),
});

const cloudTraceCacheSchema = z.object({
  type: z.literal("cloud").optional(),
  spans: z.array(spanCacheSchema),
});

interface CacheState {
  loaded: boolean;
  version: number;
  events: SavedEvent[];
  folders: FolderEntry[];
}

const state: CacheState = { loaded: false, version: 0, events: [], folders: [] };
let loadPromise: Promise<void> | null = null;

function emitSavedRunsChanged() {
  state.version += 1;
  window.dispatchEvent(new Event(SAVED_RUNS_REFRESH_EVENT));
}

export function subscribeSavedRuns(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(SAVED_RUNS_REFRESH_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(SAVED_RUNS_REFRESH_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

function getSnapshot() {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.version;
}

function getServerSnapshot() {
  return state.version;
}

function parseSavedEvent(value: unknown): SavedEvent | null {
  const parsed = savedEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseFolderEntry(value: unknown): FolderEntry | null {
  const parsed = folderEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function applyServerPayload(payload: unknown) {
  const parsed = savedRunsPayloadSchema.safeParse(payload);
  if (!parsed.success) return;
  if (parsed.data.events) {
    state.events = parsed.data.events
      .map(parseSavedEvent)
      .filter((event): event is SavedEvent => event !== null)
      .sort((a, b) => b.saved_at - a.saved_at);
  }
  if (parsed.data.folders) {
    state.folders = parsed.data.folders
      .map(parseFolderEntry)
      .filter((folder): folder is FolderEntry => folder !== null);
  }
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseColorMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return z.record(z.string(), z.string()).catch({}).parse(parsed);
  } catch {
    return {};
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
    const events = parseJsonArray(rawEvents);
    const folders = parseJsonArray(rawFolders);
    const colors = parseColorMap(rawColors);

    const folderSet = new Set<string>(folders.filter((f): f is string => typeof f === "string"));
    for (const event of events) {
      const parsed = parseSavedEvent(event);
      if (parsed?.folder) folderSet.add(parsed.folder);
    }

    await Promise.all([...folderSet].map(name =>
      apiJsonOrNull("/api/saved-runs/folders", jsonInit("POST", { name, color: colors[name] })).catch(() => null)
    ));

    const validEvents = events
      .map(parseSavedEvent)
      .filter((event): event is SavedEvent => event !== null);
    await Promise.all(validEvents.map(event =>
      apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(event.id)}`, jsonInit("PUT", event)).catch(() => null)
    ));

    localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

async function loadFromServer(): Promise<void> {
  try {
    const data = await apiJson<unknown>("/api/saved-runs");
    applyServerPayload(data);
  } catch {
    // Server unreachable; leave current cache in place.
  } finally {
    state.loaded = true;
  }
}

export async function ensureSavedRunsLoaded(): Promise<void> {
  if (state.loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await migrateLegacyLocalStorage();
    await loadFromServer();
    emitSavedRunsChanged();
  })();
  return loadPromise;
}

export function useSavedRuns() {
  useSyncExternalStore(subscribeSavedRuns, getSnapshot, getServerSnapshot);
  return {
    events: getSavedEvents(),
    folders: getFolders(),
    folderColors: getFolderColors(),
  };
}

export function useSavedEvent(id: string | null | undefined) {
  useSyncExternalStore(subscribeSavedRuns, getSnapshot, getServerSnapshot);
  if (!id) return null;
  return state.events.find(event => event.id === id) ?? null;
}

export function getSavedEvents(): SavedEvent[] {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.events.slice();
}

export function getFolders(): string[] {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.folders.map(f => f.name);
}

export function getFolderColors(): Record<string, string> {
  return Object.fromEntries(state.folders.map(f => [f.name, f.color]));
}

export function getFolderColor(folder: string): string {
  const existing = state.folders.find(f => f.name === folder);
  return existing?.color ?? "#9ca3af";
}

export function addFolder(name: string) {
  if (!name) return;
  if (!state.folders.some(f => f.name === name)) {
    state.folders = [...state.folders, { name, color: "#9ca3af" }];
    emitSavedRunsChanged();
  }
  apiJsonOrNull<{ folder?: FolderEntry }>("/api/saved-runs/folders", jsonInit("POST", { name }))
    .then(data => {
      if (data?.folder) {
        state.folders = state.folders.map(f => f.name === data.folder!.name ? { name: data.folder!.name, color: data.folder!.color } : f);
        emitSavedRunsChanged();
      }
    })
    .catch(() => {});
}

export function removeFolder(name: string) {
  state.folders = state.folders.filter(f => f.name !== name);
  state.events = state.events.map(e => e.folder === name ? { ...e, folder: undefined } : e);
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/folders/${encodeURIComponent(name)}`, jsonInit("DELETE")).catch(() => {});
}

export function saveEvent(event: SavedEvent) {
  if (state.events.some(e => e.id === event.id)) return;
  state.events = [event, ...state.events];
  if (event.folder && !state.folders.some(f => f.name === event.folder)) {
    state.folders = [...state.folders, { name: event.folder, color: "#9ca3af" }];
  }
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(event.id)}`, jsonInit("PUT", event))
    .then(() => loadFromServer().then(emitSavedRunsChanged))
    .catch(() => {});
  summarizeAndUpdate(event).catch(() => {});
}

export function removeSavedEvent(id: string) {
  state.events = state.events.filter(e => e.id !== id);
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(id)}`, jsonInit("DELETE")).catch(() => {});
  apiJsonOrNull(`/api/saved-runs/cache/${encodeURIComponent(id)}`, jsonInit("DELETE")).catch(() => {});
}

function applySavedEventFolder(id: string, folder: string | undefined) {
  const idx = state.events.findIndex(e => e.id === id);
  if (idx === -1) return;
  state.events = state.events.map((e, i) => i === idx ? { ...e, folder } : e);
  if (folder && !state.folders.some(f => f.name === folder)) {
    state.folders = [...state.folders, { name: folder, color: "#9ca3af" }];
  }
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(id)}`, jsonInit("PATCH", { folder: folder ?? null }))
    .then(() => loadFromServer().then(emitSavedRunsChanged))
    .catch(() => {});
}

export function moveSavedEventToFolder(id: string, folder: string | undefined) {
  applySavedEventFolder(id, folder);
}

export function setSavedEventSummary(id: string, summary: string) {
  const idx = state.events.findIndex(e => e.id === id);
  if (idx === -1) return;
  state.events = state.events.map((e, i) => i === idx ? { ...e, summary } : e);
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(id)}`, jsonInit("PATCH", { summary }))
    .then(() => loadFromServer().then(emitSavedRunsChanged))
    .catch(() => {});
}

export function isEventSaved(id: string): boolean {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.events.some(e => e.id === id);
}

async function summarizeAndUpdate(event: SavedEvent): Promise<void> {
  try {
    const content = [
      `Event: ${event.event_name}`,
      event.user_input ? `User: ${event.user_input.slice(0, 1500)}` : null,
      event.assistant_output ? `Assistant: ${event.assistant_output.slice(0, 1500)}` : null,
      event.signals?.length ? `Signals: ${event.signals.map(s => s.name).join(", ")}` : null,
    ].filter(Boolean).join("\n\n");

    const data = await apiJsonOrNull<{ summary?: string }>("/api/summarize", jsonInit("POST", { content }));
    if (data?.summary) {
      setSavedEventSummary(event.id, data.summary);
      emitSavedRunsChanged();
    }
  } catch {
    // Summary is non-critical.
  }
}

export async function setCloudTraceCache(id: string, spans: Span[]): Promise<void> {
  await apiJsonOrNull(`/api/saved-runs/cache/${encodeURIComponent(id)}`, jsonInit("PUT", { type: "cloud", spans })).catch(() => null);
}

export async function setLocalRunCache(id: string, data: {
  run: Run;
  spans: Span[];
  liveEvents?: LiveEvent[];
  subAgents?: SubAgent[];
}): Promise<void> {
  await apiJsonOrNull(`/api/saved-runs/cache/${encodeURIComponent(id)}`, jsonInit("PUT", {
    type: "local",
    run: data.run,
    spans: data.spans,
    liveEvents: data.liveEvents,
    subAgents: data.subAgents,
  })).catch(() => null);
}

function readCachedCloudSpans(cached: unknown): Span[] | null {
  const parsed = cloudTraceCacheSchema.safeParse(cached);
  return parsed.success ? parsed.data.spans : null;
}

export async function getCachedCloudTraceSpans(id: string): Promise<Span[] | null> {
  const cached = await apiJsonOrNull<unknown>(`/api/saved-runs/cache/${encodeURIComponent(id)}`);
  return readCachedCloudSpans(cached);
}

ensureSavedRunsLoaded().catch(() => {});

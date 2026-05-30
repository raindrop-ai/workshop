import { Database } from "bun:sqlite";
import { and, asc, count, desc, eq, gte, inArray, isNull, like, ne, or, sql as drizzleSql, type SQL } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import path from "path";
import os from "os";
import fs from "fs";
import { fileURLToPath } from "url";
import { detectSubAgents } from "./agents";
import { normalizeStoredSpan } from "./spans/normalize";
import type { NormalizedSpan } from "./spans/normalized";
import * as schema from "./db/schema";
import { embeddedMigrationFiles, embeddedMigrationJournal } from "./db/migration-assets";
import { VERSION } from "./version";

const WORKSHOP_DB_PATH_ENV_VAR = "RAINDROP_WORKSHOP_DB_PATH";
const OBSERVER_RUN_METADATA_RE = /"role"\s*:\s*"observer"|"observerKind"\s*:\s*"llm-as-judge"|"observedRunId"\s*:/;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveDbPath(): string {
  const explicit = process.env[WORKSHOP_DB_PATH_ENV_VAR];
  if (explicit && explicit.trim()) {
    return explicit;
  }
  return path.join(os.homedir(), ".raindrop", "raindrop_workshop.db");
}

function resolveMigrationsFolder(): string {
  const fromSource = path.resolve(MODULE_DIR, "..", "drizzle");
  if (fs.existsSync(path.join(fromSource, "meta", "_journal.json"))) {
    return fromSource;
  }
  return ensureEmbeddedMigrationsFolder();
}

function ensureEmbeddedMigrationsFolder(): string {
  const cacheRoot = path.join(os.homedir(), ".raindrop", "migrations", VERSION);
  const journalPath = path.join(cacheRoot, "meta", "_journal.json");
  const hasAllFiles =
    fs.existsSync(journalPath) &&
    embeddedMigrationFiles.every((asset) => fs.existsSync(path.join(cacheRoot, asset.relativePath)));
  if (hasAllFiles) return cacheRoot;

  const tmp = `${cacheRoot}.extract.${process.pid}.${Date.now()}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "meta"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "meta", "_journal.json"), JSON.stringify(embeddedMigrationJournal, null, 2));
  for (const asset of embeddedMigrationFiles) {
    const target = path.join(tmp, asset.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(asset.sourcePath));
  }

  fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  fs.renameSync(tmp, cacheRoot);
  return cacheRoot;
}

let _sqliteDb: Database | null = null;
let _dbPath: string | null = null;
type WorkshopDb = BunSQLiteDatabase<typeof schema> & { $client: Database };
let _drizzleDb: WorkshopDb | null = null;

export function getDbPath(): string {
  if (_dbPath) return _dbPath;
  _dbPath = resolveDbPath();
  return _dbPath;
}

export function getDrizzleDb(): WorkshopDb {
  if (_drizzleDb) return _drizzleDb;
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _dbPath = dbPath;
  _sqliteDb = new Database(dbPath, { create: true });
  _sqliteDb.exec("PRAGMA journal_mode = WAL");
  _sqliteDb.exec("PRAGMA foreign_keys = ON");
  _drizzleDb = drizzle(_sqliteDb, { schema });
  try {
    migrate(_drizzleDb, { migrationsFolder: resolveMigrationsFolder() });
  } catch (err) {
    closeDb();
    throw new Error(
      `Failed to migrate Workshop DB at ${dbPath}: ${(err as Error).message}\n` +
        `If you do not need the local trace history, run: raindrop workshop reset`,
    );
  }
  return _drizzleDb;
}

type DrizzleExecutor = Pick<WorkshopDb, "run" | "get" | "all" | "values">;

function bindRawSql(query: string, args: unknown[]): SQL {
  if (args.length === 0) return drizzleSql.raw(query);
  const parts = query.split("?");
  if (parts.length - 1 !== args.length) {
    throw new Error(`SQL parameter mismatch: expected ${parts.length - 1}, got ${args.length}`);
  }
  const chunks: unknown[] = [];
  for (let i = 0; i < parts.length; i++) {
    chunks.push(drizzleSql.raw(parts[i]));
    if (i < args.length) chunks.push(drizzleSql.param(args[i]));
  }
  return drizzleSql.join(chunks as any[]);
}

// Raw SQL escape hatch for queryTraces and the few trace reads that depend on
// dynamic SQL fragments, SQLite scalar functions, or regex post-filtering.
function rawQuery(query: string, executor?: DrizzleExecutor) {
  if (!executor) {
    const stmt = getDrizzleDb().$client.prepare(query);
    return {
      run: (...args: unknown[]) => stmt.run(...(args as any[])),
      get: <T = unknown>(...args: unknown[]) => stmt.get(...(args as any[])) as T | undefined,
      all: <T = unknown>(...args: unknown[]) => stmt.all(...(args as any[])) as T[],
      values: <T extends unknown[] = unknown[]>(...args: unknown[]) => stmt.values(...(args as any[])) as T[],
    };
  }
  return {
    run: (...args: unknown[]) => executor.run(bindRawSql(query, args)),
    get: <T = unknown>(...args: unknown[]) => executor.get<T>(bindRawSql(query, args)),
    all: <T = unknown>(...args: unknown[]) => executor.all<T>(bindRawSql(query, args)),
    values: <T extends unknown[] = unknown[]>(...args: unknown[]) => executor.values<T>(bindRawSql(query, args)),
  };
}

export interface QueryTracesOpts {
  limit?: number;
  maxBytes?: number;
}

export interface QueryTracesResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
}

const BLOCKED_QUERY_RE = /\b(attach|detach|insert|update|delete|replace|drop|alter|create|pragma|vacuum|reindex|analyze)\b/i;
const OUTPUT_AMPLIFYING_SQL_FUNCTIONS = [
  "randomblob",
  "zeroblob",
  "printf",
  "format",
  "hex",
  "quote",
  "group_concat",
  "json_group_array",
  "json_group_object",
].join("|");
const BLOCKED_EXPENSIVE_QUERY_RE = new RegExp(
  `(?:\\b(${OUTPUT_AMPLIFYING_SQL_FUNCTIONS})\\b|["'\`](${OUTPUT_AMPLIFYING_SQL_FUNCTIONS})["'\`]|\\[(${OUTPUT_AMPLIFYING_SQL_FUNCTIONS})\\])\\s*\\(`,
  "i",
);

// `messages` holds legacy Workshop chat history, not trace data. Block it so
// query_traces can't be used as a side-channel to read the user's
// conversations with Claude.
const BLOCKED_TABLES_RE = /\bmessages\b/i;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n\r]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function assertReadOnlyTraceQuery(sql: string): string {
  const trimmed = stripSqlComments(sql).trim();
  if (!trimmed) throw new Error("sql required");

  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "").trim();
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("only one SQL statement is allowed");
  }
  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("only SELECT queries are allowed");
  }
  // SQLite executes recursive CTEs even when the optional RECURSIVE keyword
  // is omitted. Until execution can be time-bounded, reject all CTE syntax.
  if (/\bwith\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("query_traces does not allow CTEs");
  }
  if (BLOCKED_QUERY_RE.test(withoutTrailingSemicolon)) {
    throw new Error("query contains a blocked SQL keyword");
  }
  if (BLOCKED_EXPENSIVE_QUERY_RE.test(withoutTrailingSemicolon)) {
    throw new Error("query_traces does not allow SQL functions that can amplify output size");
  }
  if (BLOCKED_TABLES_RE.test(withoutTrailingSemicolon)) {
    throw new Error("query_traces cannot read the messages table (Workshop chat history is not trace data)");
  }
  return withoutTrailingSemicolon;
}

export function queryTraces(sql: string, opts: QueryTracesOpts = {}): QueryTracesResult {
  const started = Date.now();
  const safeSql = assertReadOnlyTraceQuery(sql);
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
  const maxBytes = Math.max(1_000, Math.min(1_000_000, opts.maxBytes ?? 120_000));

  const wrappedSql = `SELECT * FROM (${safeSql}) LIMIT ${limit + 1}`;
  const rawRows = rawQuery(wrappedSql).all<Record<string, unknown>>();
  let truncated = rawRows.length > limit;
  const rows = rawRows.slice(0, limit);
  const columns = rows[0] ? Object.keys(rows[0]) : [];

  let keptRows = rows;
  while (keptRows.length > 0) {
    const body = { columns, rows: keptRows, row_count: keptRows.length, truncated, elapsed_ms: 0 };
    if (JSON.stringify(body).length <= maxBytes) break;
    keptRows = keptRows.slice(0, -1);
    truncated = true;
  }

  return {
    columns,
    rows: keptRows,
    row_count: keptRows.length,
    truncated,
    elapsed_ms: Date.now() - started,
  };
}

export function closeDb(): void {
  if (_sqliteDb) {
    _sqliteDb.close();
    _sqliteDb = null;
  }
  _drizzleDb = null;
  _dbPath = null;
}

export function upsertRun(run: { id: string; event_id?: string; name?: string; event_name?: string; user_id?: string; convo_id?: string; started_at: number; last_updated_at: number; metadata?: string }) {
  getDrizzleDb()
    .insert(schema.runs)
    .values({
      id: run.id,
      event_id: run.event_id ?? null,
      name: run.name ?? null,
      event_name: run.event_name ?? null,
      user_id: run.user_id ?? null,
      convo_id: run.convo_id ?? null,
      started_at: run.started_at,
      last_updated_at: run.last_updated_at,
      metadata: run.metadata ?? null,
    })
    .onConflictDoUpdate({
      target: schema.runs.id,
      set: {
        event_id: drizzleSql`COALESCE(excluded.event_id, ${schema.runs.event_id})`,
        name: drizzleSql`COALESCE(excluded.name, ${schema.runs.name})`,
        event_name: drizzleSql`COALESCE(excluded.event_name, ${schema.runs.event_name})`,
        user_id: drizzleSql`COALESCE(excluded.user_id, ${schema.runs.user_id})`,
        convo_id: drizzleSql`COALESCE(excluded.convo_id, ${schema.runs.convo_id})`,
        last_updated_at: drizzleSql`MAX(excluded.last_updated_at, ${schema.runs.last_updated_at})`,
        started_at: drizzleSql`MIN(excluded.started_at, ${schema.runs.started_at})`,
        metadata: drizzleSql`COALESCE(excluded.metadata, ${schema.runs.metadata})`,
      },
    })
    .run();
}

export function findRunByEventId(eventId: string): { id: string } | null {
  return getDrizzleDb()
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(eq(schema.runs.event_id, eventId))
    .orderBy(drizzleSql`CASE WHEN ${schema.runs.id} = ${eventId} THEN 1 ELSE 0 END`, desc(schema.runs.last_updated_at))
    .limit(1)
    .get() ?? null;
}

export function adoptRunByEventId(eventId: string, newRunId: string): boolean {
  getDrizzleDb()
    .update(schema.runs)
    .set({ event_id: drizzleSql`COALESCE(${schema.runs.event_id}, ${eventId})` })
    .where(eq(schema.runs.id, newRunId))
    .run();

  const existing = getDrizzleDb()
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(and(or(eq(schema.runs.event_id, eventId), eq(schema.runs.id, eventId)), ne(schema.runs.id, newRunId)))
    .all();
  if (existing.length === 0) return false;

  getDrizzleDb().transaction((tx) => {
    for (const row of existing) {
      rawQuery(`
        UPDATE runs
        SET
          name = COALESCE(runs.name, source.name),
          event_name = COALESCE(runs.event_name, source.event_name),
          user_id = COALESCE(runs.user_id, source.user_id),
          convo_id = COALESCE(runs.convo_id, source.convo_id),
          started_at = MIN(runs.started_at, source.started_at),
          last_updated_at = MAX(runs.last_updated_at, source.last_updated_at),
          metadata = COALESCE(runs.metadata, source.metadata)
        FROM runs AS source
        WHERE runs.id = ?
          AND source.id = ?
      `, tx).run(newRunId, row.id);
      tx.update(schema.spans).set({ run_id: newRunId }).where(eq(schema.spans.run_id, row.id)).run();
      tx.update(schema.live_events).set({ trace_id: newRunId }).where(eq(schema.live_events.trace_id, row.id)).run();
      tx.delete(schema.runs).where(eq(schema.runs.id, row.id)).run();
    }
  });
  return true;
}

export function updateRunMetadata(runId: string, metadata: string) {
  getDrizzleDb().update(schema.runs).set({ metadata }).where(eq(schema.runs.id, runId)).run();
}

export function findRecentRunByEventName(eventName: string, afterTimestamp: number, excludeId?: string): any {
  const where = excludeId
    ? and(eq(schema.runs.event_name, eventName), gte(schema.runs.started_at, afterTimestamp), ne(schema.runs.id, excludeId))
    : and(eq(schema.runs.event_name, eventName), gte(schema.runs.started_at, afterTimestamp));
  return getDrizzleDb()
    .select()
    .from(schema.runs)
    .where(where)
    .orderBy(desc(schema.runs.started_at))
    .limit(1)
    .get() ?? null;
}

export function countReplaysBySource(sourceRunId: string): number {
  const row = getDrizzleDb()
    .select({ count: count() })
    .from(schema.runs)
    .where(like(schema.runs.metadata, `%"sourceRunId":"${sourceRunId}"%`))
    .get();
  return row?.count ?? 0;
}

export function deleteRun(runId: string) {
  getDrizzleDb().transaction((tx) => {
    tx.delete(schema.steering_events)
      .where(or(eq(schema.steering_events.observed_run_id, runId), eq(schema.steering_events.observer_run_id, runId)))
      .run();
    tx.delete(schema.spans).where(eq(schema.spans.run_id, runId)).run();
    tx.delete(schema.live_events).where(eq(schema.live_events.trace_id, runId)).run();
    tx.delete(schema.runs).where(eq(schema.runs.id, runId)).run();
  });
}

export function insertSpan(span: { id: string; run_id: string; parent_span_id?: string; name: string; span_type?: string; status?: string; input_payload?: string; output_payload?: string; start_time_ms: number; end_time_ms: number; duration_ms: number; model?: string; provider?: string; input_tokens?: number; output_tokens?: number; attributes?: string }) {
  const row = {
    id: span.id,
    run_id: span.run_id,
    parent_span_id: span.parent_span_id ?? null,
    name: span.name,
    span_type: span.span_type ?? null,
    status: span.status ?? "UNSET",
    input_payload: span.input_payload ?? null,
    output_payload: span.output_payload ?? null,
    start_time_ms: span.start_time_ms,
    end_time_ms: span.end_time_ms,
    duration_ms: span.duration_ms,
    model: span.model ?? null,
    provider: span.provider ?? null,
    input_tokens: span.input_tokens ?? null,
    output_tokens: span.output_tokens ?? null,
    attributes: span.attributes ?? null,
  };
  getDrizzleDb()
    .insert(schema.spans)
    .values(row)
    .onConflictDoUpdate({ target: schema.spans.id, set: row })
    .run();
}

export function upsertEventSpan(span: { id: string; run_id: string; name: string; span_type?: string; status?: string; input_payload?: string; output_payload?: string; start_time_ms: number; end_time_ms: number; duration_ms: number; model?: string; attributes?: string }) {
  getDrizzleDb()
    .insert(schema.spans)
    .values({
      id: span.id,
      run_id: span.run_id,
      name: span.name,
      span_type: span.span_type ?? null,
      status: span.status ?? "UNSET",
      input_payload: span.input_payload ?? null,
      output_payload: span.output_payload ?? null,
      start_time_ms: span.start_time_ms,
      end_time_ms: span.end_time_ms,
      duration_ms: span.duration_ms,
      model: span.model ?? null,
      attributes: span.attributes ?? null,
    })
    .onConflictDoUpdate({
      target: schema.spans.id,
      set: {
        name: drizzleSql`COALESCE(excluded.name, ${schema.spans.name})`,
        span_type: drizzleSql`COALESCE(excluded.span_type, ${schema.spans.span_type})`,
        status: drizzleSql`CASE WHEN excluded.status != 'UNSET' THEN excluded.status ELSE ${schema.spans.status} END`,
        input_payload: drizzleSql`COALESCE(excluded.input_payload, ${schema.spans.input_payload})`,
        output_payload: drizzleSql`COALESCE(excluded.output_payload, ${schema.spans.output_payload})`,
        start_time_ms: drizzleSql`MIN(excluded.start_time_ms, ${schema.spans.start_time_ms})`,
        end_time_ms: drizzleSql`MAX(excluded.end_time_ms, ${schema.spans.end_time_ms})`,
        duration_ms: drizzleSql`MAX(excluded.end_time_ms, ${schema.spans.end_time_ms}) - MIN(excluded.start_time_ms, ${schema.spans.start_time_ms})`,
        model: drizzleSql`COALESCE(excluded.model, ${schema.spans.model})`,
        attributes: drizzleSql`COALESCE(excluded.attributes, ${schema.spans.attributes})`,
      },
    })
    .run();
}

export function getRuns(limit = 200) {
  return getDrizzleDb()
    .select()
    .from(schema.runs_with_hints)
    .where(drizzleSql`
      COALESCE(${schema.runs_with_hints.event_name}, '') != 'observer_agent_session'
      AND COALESCE(${schema.runs_with_hints.user_id}, '') != 'opencode-observer'
      AND COALESCE(${schema.runs_with_hints.metadata}, '') NOT LIKE '%"observedRunId"%'
    `)
    .orderBy(desc(schema.runs_with_hints.last_updated_at))
    .limit(limit)
    .all();
}

export function getObserverRunsForObservedRun(observedRunId: string) {
  return getDrizzleDb()
    .select()
    .from(schema.runs_with_hints)
    .where(drizzleSql`
      COALESCE(${schema.runs_with_hints.metadata}, '') LIKE ${`%"observedRunId":"${observedRunId}"%`}
      OR COALESCE(${schema.runs_with_hints.metadata}, '') LIKE ${`%"observedRunId": "${observedRunId}"%`}
    `)
    .orderBy(desc(schema.runs_with_hints.last_updated_at))
    .all();
}

export function isObserverRun(row: { event_name?: string | null; user_id?: string | null; metadata?: string | null }): boolean {
  return row.event_name === "observer_agent_session" ||
    row.user_id === "opencode-observer" ||
    Boolean(row.metadata && OBSERVER_RUN_METADATA_RE.test(row.metadata));
}

export function hasAnyRuns(): boolean {
  const row = getDrizzleDb()
    .select({ value: count() })
    .from(schema.runs)
    .get();
  return (row?.value ?? 0) > 0;
}

/**
 * Augment a stored span row with the SDK-agnostic typed view produced by
 * the adapter dispatcher. Done here (rather than at write time) so that
 * old DB rows automatically get a normalized view too — no migration or
 * backfill required.
 */
function attachNormalized<T extends {
  name: string;
  span_type: string | null;
  input_payload: string | null;
  output_payload: string | null;
  attributes: string | null;
}>(span: T): T & { normalized: NormalizedSpan } {
  return { ...span, normalized: normalizeStoredSpan(span).normalized };
}

export function getRunWithSpans(runId: string) {
  // Use runs_with_hints so the detail endpoint surfaces the same `finished`
  // / `span_count` / `live_event_count` / `payload_total_chars` derivations
  // that the sidebar's `/api/runs` list relies on. Without this `run.finished`
  // comes back undefined and `RunDetail.isActive(run)` falls through to the
  // 30 s `last_updated_at` heuristic, so the title pulse lingers for the full
  // window after a run actually completes.
  const run = getDrizzleDb()
    .select()
    .from(schema.runs_with_hints)
    .where(eq(schema.runs_with_hints.id, runId))
    .limit(1)
    .get();
  const rows = getDrizzleDb()
    .select()
    .from(schema.spans)
    .where(eq(schema.spans.run_id, runId))
    .orderBy(asc(schema.spans.start_time_ms))
    .all() as Array<{
    name: string;
    span_type: string | null;
    input_payload: string | null;
    output_payload: string | null;
    attributes: string | null;
  }>;
  const spans = rows.map(attachNormalized);
  return { run: run ?? null, spans };
}

export function getSpanPayloadColumn(spanId: string, target: "input" | "output"): string | null {
  const payloadColumn = target === "input" ? schema.spans.input_payload : schema.spans.output_payload;
  const row = getDrizzleDb()
    .select({ payload: payloadColumn, run_id: schema.spans.run_id })
    .from(schema.spans)
    .where(eq(schema.spans.id, spanId))
    .limit(1)
    .get();
  if (!row) return null;
  return row.payload ?? "";
}

export function getSpanById(spanId: string) {
  const row = getDrizzleDb()
    .select()
    .from(schema.spans)
    .where(eq(schema.spans.id, spanId))
    .limit(1)
    .get() as any;
  return row ? attachNormalized(row) : null;
}

// Row shape returned by getSpanMeta. Mirrors the spans table columns selected
// below, plus the COALESCE/SUBSTR/LENGTH-derived preview fields (which are
// always non-null because of the COALESCE).
export interface SpanMetaRow {
  id: string;
  run_id: string;
  parent_span_id: string | null;
  name: string;
  span_type: string | null;
  status: string | null;
  start_time_ms: number | null;
  end_time_ms: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  provider: string | null;
  attributes: string | null;
  input_head: string;
  input_chars: number;
  output_head: string;
  output_chars: number;
}

export function getSpanMeta(spanId: string): SpanMetaRow | null {
  return getDrizzleDb()
    .select({
      id: schema.spans.id,
      run_id: schema.spans.run_id,
      parent_span_id: schema.spans.parent_span_id,
      name: schema.spans.name,
      span_type: schema.spans.span_type,
      status: schema.spans.status,
      start_time_ms: schema.spans.start_time_ms,
      end_time_ms: schema.spans.end_time_ms,
      duration_ms: schema.spans.duration_ms,
      input_tokens: schema.spans.input_tokens,
      output_tokens: schema.spans.output_tokens,
      model: schema.spans.model,
      provider: schema.spans.provider,
      attributes: schema.spans.attributes,
      input_head: drizzleSql<string>`SUBSTR(COALESCE(${schema.spans.input_payload}, ''), 1, 81)`,
      input_chars: drizzleSql<number>`LENGTH(COALESCE(${schema.spans.input_payload}, ''))`,
      output_head: drizzleSql<string>`SUBSTR(COALESCE(${schema.spans.output_payload}, ''), 1, 81)`,
      output_chars: drizzleSql<number>`LENGTH(COALESCE(${schema.spans.output_payload}, ''))`,
    })
    .from(schema.spans)
    .where(eq(schema.spans.id, spanId))
    .limit(1)
    .get() ?? null;
}

export function getRunById(runId: string) {
  return getDrizzleDb()
    .select()
    .from(schema.runs_with_hints)
    .where(eq(schema.runs_with_hints.id, runId))
    .limit(1)
    .get() ?? null;
}

export function getMostRecentlyTouchedRun() {
  return getDrizzleDb()
    .select()
    .from(schema.runs_with_hints)
    .orderBy(desc(schema.runs_with_hints.last_updated_at))
    .limit(1)
    .get() ?? null;
}

export function upsertLiveEvent(event: { traceId: string; spanId?: string; type: string; content?: string; timestamp: number; metadata?: Record<string, any> }) {
  getDrizzleDb().insert(schema.live_events).values({
    trace_id: event.traceId,
    span_id: event.spanId ?? null,
    type: event.type,
    content: event.content ?? null,
    timestamp: event.timestamp,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
  }).run();
}

export function getLiveEvents(traceId: string) {
  return getDrizzleDb()
    .select()
    .from(schema.live_events)
    .where(eq(schema.live_events.trace_id, traceId))
    .orderBy(asc(schema.live_events.timestamp))
    .all();
}

export function tailLiveEvents(
  runId: string,
  opts: { after_id?: number; types?: string[]; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const filters = [eq(schema.live_events.trace_id, runId)];
  if (typeof opts.after_id === "number") filters.push(drizzleSql`${schema.live_events.id} > ${opts.after_id}`);
  if (opts.types && opts.types.length) filters.push(inArray(schema.live_events.type, opts.types));
  const events = getDrizzleDb()
    .select({
      id: schema.live_events.id,
      span_id: schema.live_events.span_id,
      type: schema.live_events.type,
      content: schema.live_events.content,
      timestamp: schema.live_events.timestamp,
      metadata: schema.live_events.metadata,
    })
    .from(schema.live_events)
    .where(and(...filters))
    .orderBy(asc(schema.live_events.id))
    .limit(limit)
    .all() as any[];

  const next_after_id = events.length
    ? events[events.length - 1].id
    : (typeof opts.after_id === "number" ? opts.after_id : 0);

  return { events, next_after_id };
}

export function getRunsByConvoId(convoId: string) {
  return getDrizzleDb()
    .select()
    .from(schema.runs_with_hints)
    .where(eq(schema.runs_with_hints.convo_id, convoId))
    .orderBy(asc(schema.runs_with_hints.started_at))
    .all();
}

export function clearAll() {
  getDrizzleDb().transaction((tx) => {
    tx.delete(schema.steering_events).run();
    tx.delete(schema.live_events).run();
    tx.delete(schema.spans).run();
    tx.delete(schema.runs).run();
  });
}

export function cacheSavedRun(id: string, data: string) {
  getDrizzleDb()
    .insert(schema.saved_run_cache)
    .values({ id, data })
    .onConflictDoUpdate({ target: schema.saved_run_cache.id, set: { data } })
    .run();
}

export function getCachedRun(id: string): string | null {
  const row = getDrizzleDb()
    .select({ data: schema.saved_run_cache.data })
    .from(schema.saved_run_cache)
    .where(eq(schema.saved_run_cache.id, id))
    .limit(1)
    .get();
  return row?.data ?? null;
}

export function deleteCachedRun(id: string) {
  getDrizzleDb().delete(schema.saved_run_cache).where(eq(schema.saved_run_cache.id, id)).run();
}

export interface SavedEventRow {
  id: string;
  event_name: string;
  user_id: string | null;
  convo_id: string | null;
  timestamp: string;
  user_input: string | null;
  assistant_output: string | null;
  signals: { id: string; name: string; score?: number }[] | null;
  properties: Record<string, unknown> | null;
  saved_at: number;
  summary: string | null;
  source: "local" | "cloud" | null;
  folder: string | null;
}

interface SavedEventDbRow {
  id: string;
  event_name: string;
  user_id: string | null;
  convo_id: string | null;
  timestamp: string;
  user_input: string | null;
  assistant_output: string | null;
  signals: string | null;
  properties: string | null;
  saved_at: number;
  summary: string | null;
  source: string | null;
  folder: string | null;
}

function rowToSavedEvent(r: SavedEventDbRow): SavedEventRow {
  let signals: SavedEventRow["signals"] = null;
  let properties: SavedEventRow["properties"] = null;
  try { signals = r.signals ? JSON.parse(r.signals) : null; } catch { signals = null; }
  try { properties = r.properties ? JSON.parse(r.properties) : null; } catch { properties = null; }
  return {
    id: r.id,
    event_name: r.event_name,
    user_id: r.user_id,
    convo_id: r.convo_id,
    timestamp: r.timestamp,
    user_input: r.user_input,
    assistant_output: r.assistant_output,
    signals,
    properties,
    saved_at: r.saved_at,
    summary: r.summary,
    source: r.source === "local" || r.source === "cloud" ? r.source : null,
    folder: r.folder,
  };
}

export function listSavedEvents(): SavedEventRow[] {
  const rows = getDrizzleDb()
    .select()
    .from(schema.saved_events)
    .orderBy(desc(schema.saved_events.saved_at))
    .all() as SavedEventDbRow[];
  return rows.map(rowToSavedEvent);
}

export function getSavedEvent(id: string): SavedEventRow | null {
  const row = getDrizzleDb()
    .select()
    .from(schema.saved_events)
    .where(eq(schema.saved_events.id, id))
    .limit(1)
    .get() as SavedEventDbRow | undefined;
  return row ? rowToSavedEvent(row) : null;
}

export function upsertSavedEvent(event: SavedEventRow): void {
  getDrizzleDb().insert(schema.saved_events).values({
    id: event.id,
    event_name: event.event_name,
    user_id: event.user_id ?? null,
    convo_id: event.convo_id ?? null,
    timestamp: event.timestamp,
    user_input: event.user_input ?? null,
    assistant_output: event.assistant_output ?? null,
    signals: event.signals ? JSON.stringify(event.signals) : null,
    properties: event.properties ? JSON.stringify(event.properties) : null,
    saved_at: event.saved_at,
    summary: event.summary ?? null,
    source: event.source ?? null,
    folder: event.folder ?? null,
  }).onConflictDoUpdate({
    target: schema.saved_events.id,
    set: {
      event_name: drizzleSql`COALESCE(excluded.event_name, ${schema.saved_events.event_name})`,
      user_id: drizzleSql`COALESCE(excluded.user_id, ${schema.saved_events.user_id})`,
      convo_id: drizzleSql`COALESCE(excluded.convo_id, ${schema.saved_events.convo_id})`,
      timestamp: drizzleSql`COALESCE(excluded.timestamp, ${schema.saved_events.timestamp})`,
      user_input: drizzleSql`COALESCE(excluded.user_input, ${schema.saved_events.user_input})`,
      assistant_output: drizzleSql`COALESCE(excluded.assistant_output, ${schema.saved_events.assistant_output})`,
      signals: drizzleSql`COALESCE(excluded.signals, ${schema.saved_events.signals})`,
      properties: drizzleSql`COALESCE(excluded.properties, ${schema.saved_events.properties})`,
      saved_at: drizzleSql`COALESCE(excluded.saved_at, ${schema.saved_events.saved_at})`,
      summary: drizzleSql`COALESCE(excluded.summary, ${schema.saved_events.summary})`,
      source: drizzleSql`COALESCE(excluded.source, ${schema.saved_events.source})`,
      folder: drizzleSql`excluded.folder`,
    },
  }).run();
}

export function patchSavedEvent(id: string, patch: Partial<Omit<SavedEventRow, "id">>): SavedEventRow | null {
  const current = getSavedEvent(id);
  if (!current) return null;
  const next: SavedEventRow = { ...current, ...patch };
  // Allow folder to be explicitly set to null/undefined to "unfile"
  if (Object.prototype.hasOwnProperty.call(patch, "folder")) next.folder = patch.folder ?? null;
  upsertSavedEvent(next);
  return next;
}

export function deleteSavedEvent(id: string): void {
  getDrizzleDb().delete(schema.saved_events).where(eq(schema.saved_events.id, id)).run();
}

export interface SavedFolderRow {
  name: string;
  color: string;
  created_at: number;
}

const FOLDER_PALETTE = [
  "#6ee7b7", // green
  "#93c5fd", // blue
  "#c4b5fd", // purple
  "#fca5a5", // red
  "#fdba74", // orange
  "#fde68a", // yellow
  "#f9a8d4", // pink
  "#67e8f9", // cyan
] as const;

export function listSavedFolders(): SavedFolderRow[] {
  return getDrizzleDb()
    .select({ name: schema.saved_folders.name, color: schema.saved_folders.color, created_at: schema.saved_folders.created_at })
    .from(schema.saved_folders)
    .orderBy(asc(schema.saved_folders.created_at))
    .all();
}

function getSavedFolder(name: string): SavedFolderRow | null {
  return getDrizzleDb()
    .select({ name: schema.saved_folders.name, color: schema.saved_folders.color, created_at: schema.saved_folders.created_at })
    .from(schema.saved_folders)
    .where(eq(schema.saved_folders.name, name))
    .limit(1)
    .get() ?? null;
}

export function ensureSavedFolder(name: string, providedColor?: string): SavedFolderRow {
  const existing = getSavedFolder(name);
  if (existing) {
    if (providedColor && providedColor !== existing.color) {
      getDrizzleDb().update(schema.saved_folders).set({ color: providedColor }).where(eq(schema.saved_folders.name, name)).run();
      return { ...existing, color: providedColor };
    }
    return existing;
  }
  const used = new Set(listSavedFolders().map(f => f.color));
  const color = providedColor ?? FOLDER_PALETTE.find(c => !used.has(c)) ?? FOLDER_PALETTE[used.size % FOLDER_PALETTE.length];
  const created_at = Date.now();
  getDrizzleDb().insert(schema.saved_folders).values({ name, color, created_at }).run();
  return { name, color, created_at };
}

export function deleteSavedFolder(name: string): void {
  getDrizzleDb().transaction((tx) => {
    tx.update(schema.saved_events).set({ folder: null }).where(eq(schema.saved_events.folder, name)).run();
    tx.delete(schema.saved_folders).where(eq(schema.saved_folders.name, name)).run();
  });
}

export interface OutlineSpan {
  id: string;
  parent_id: string | null;
  depth: number;
  name: string;
  span_type: string | null;
  status: string;
  duration_ms: number;
  tokens: { in: number; out: number };
  model: string | null;
  input_preview: string;
  output_preview: string;
  child_count: number;
}

type ToolCallSummary = {
  name: string;
  count: number;
  errors: number;
  example: {
    span_id: string;
    status: string;
    input_preview: string;
    output_preview: string;
  };
};

export interface RunOutline {
  run: Record<string, unknown> | null;
  summary: {
    span_type_counts: Record<string, number>;
    tool_calls: {
      total: number;
      by_name: ToolCallSummary[];
    };
    final_response_preview: string;
  };
  spans: OutlineSpan[];
  live_events: {
    count: number;
    first_ts: number | null;
    last_ts: number | null;
    types: { text_delta: number; reasoning_delta: number; tool_start: number; tool_result: number };
  };
  sub_agents: Array<{ root_span_id: string; name: string; span_count: number }>;
  annotations: unknown[];
  errors: Array<{ span_id: string; name: string; ts: number; first_line_of_output: string }>;
}

function firstLine(text: string | null | undefined, cap = 200): string {
  if (!text) return "";
  const idx = text.indexOf("\n");
  const head = idx === -1 ? text : text.slice(0, idx);
  return head.length > cap ? head.slice(0, cap) : head;
}

function emptyOutline(): RunOutline {
  return {
    run: null,
    summary: {
      span_type_counts: {},
      tool_calls: { total: 0, by_name: [] },
      final_response_preview: "",
    },
    spans: [],
    live_events: {
      count: 0,
      first_ts: null,
      last_ts: null,
      types: { text_delta: 0, reasoning_delta: 0, tool_start: 0, tool_result: 0 },
    },
    sub_agents: [],
    annotations: [],
    errors: [],
  };
}

export function getRunOutline(runId: string, payloadPreviewChars = 80): RunOutline {
  const cap = Math.max(0, Math.min(400, payloadPreviewChars | 0));

  const run = rawQuery(`
    SELECT r.*,
      (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id) AS span_count,
      (SELECT COUNT(*) FROM live_events e WHERE e.trace_id = r.id) AS live_event_count,
      (SELECT COALESCE(SUM(input_tokens), 0) FROM spans s WHERE s.run_id = r.id) AS total_input_tokens,
      (SELECT COALESCE(SUM(output_tokens), 0) FROM spans s WHERE s.run_id = r.id) AS total_output_tokens,
      (SELECT COALESCE(SUM(LENGTH(COALESCE(s.input_payload, '')) + LENGTH(COALESCE(s.output_payload, ''))), 0)
       FROM spans s WHERE s.run_id = r.id) AS payload_total_chars,
      (SELECT s.model FROM spans s WHERE s.run_id = r.id AND s.model IS NOT NULL LIMIT 1) AS model,
      (SELECT MAX(end_time_ms) - MIN(start_time_ms) FROM spans s WHERE s.run_id = r.id) AS duration_ms,
      /*
       * Run-level status: ERROR if any root failed, OK if every root reached
       * a terminal status, else UNSET (still in flight). Same multi-root
        * pitfall as runs_with_hints.finished — picking one arbitrary root
       * with LIMIT 1 misclassifies legacy-SDK runs that produce N sibling
       * roots (synth + per-tool spans).
       */
      (SELECT CASE
                WHEN COUNT(*) = 0 THEN 'UNSET'
                WHEN SUM(CASE WHEN s.status = 'ERROR' THEN 1 ELSE 0 END) > 0 THEN 'ERROR'
                WHEN COUNT(*) = COUNT(CASE WHEN s.status IN ('OK','ERROR') THEN 1 END) THEN 'OK'
                ELSE 'UNSET'
              END
       FROM spans s WHERE s.run_id = r.id AND s.parent_span_id IS NULL) AS status
    FROM runs r WHERE r.id = ?
  `).get(runId);

  // Short-circuit when the run doesn't exist; the endpoint will 404 on `out.run`,
  // but skipping the four follow-up queries keeps direct helper calls cheap too.
  if (!run) return emptyOutline();

  const rawSpans = rawQuery(`
    SELECT id, parent_span_id, name, span_type, status,
           start_time_ms, end_time_ms, duration_ms,
           input_tokens, output_tokens, model,
           SUBSTR(COALESCE(input_payload, ''), 1, ?) AS input_head,
           LENGTH(COALESCE(input_payload, '')) AS input_chars,
           SUBSTR(COALESCE(output_payload, ''), 1, ?) AS output_head,
           LENGTH(COALESCE(output_payload, '')) AS output_chars
    FROM spans WHERE run_id = ?
    ORDER BY start_time_ms ASC
  `).all(cap + 1, cap + 1, runId) as any[];

  // Build a single id→span index reused for depth + child_count + sub-agents,
  // so the per-span `depthOf` walk stays O(depth) instead of O(N) per call.
  const spanById = new Map<string, any>();
  const childCounts = new Map<string, number>();
  for (const s of rawSpans) {
    spanById.set(s.id, s);
    if (s.parent_span_id) childCounts.set(s.parent_span_id, (childCounts.get(s.parent_span_id) ?? 0) + 1);
  }

  const depthCache = new Map<string, number>();
  function depthOf(s: any): number {
    if (!s.parent_span_id) return 0;
    const cached = depthCache.get(s.id);
    if (cached !== undefined) return cached;
    const parent = spanById.get(s.parent_span_id);
    const d = parent ? depthOf(parent) + 1 : 0;
    depthCache.set(s.id, d);
    return d;
  }

  const spans: OutlineSpan[] = rawSpans.map((s) => ({
    id: s.id,
    parent_id: s.parent_span_id ?? null,
    depth: depthOf(s),
    name: s.name,
    span_type: s.span_type,
    status: s.status ?? "UNSET",
    duration_ms: s.duration_ms ?? 0,
    tokens: { in: s.input_tokens ?? 0, out: s.output_tokens ?? 0 },
    model: s.model,
    input_preview: s.input_chars > cap ? s.input_head.slice(0, cap) + "…" : s.input_head,
    output_preview: s.output_chars > cap ? s.output_head.slice(0, cap) + "…" : s.output_head,
    child_count: childCounts.get(s.id) ?? 0,
  }));

  const span_type_counts: Record<string, number> = {};
  const toolCounts = new Map<string, RunOutline["summary"]["tool_calls"]["by_name"][number]>();
  let totalToolCalls = 0;
  for (const s of spans) {
    const type = s.span_type ?? "UNSET";
    span_type_counts[type] = (span_type_counts[type] ?? 0) + 1;
    if (s.span_type === "TOOL_CALL") {
      totalToolCalls++;
      const existing = toolCounts.get(s.name) ?? {
        name: s.name,
        count: 0,
        errors: 0,
        example: {
          span_id: s.id,
          status: s.status,
          input_preview: s.input_preview,
          output_preview: s.output_preview,
        },
      };
      existing.count++;
      if (s.status === "ERROR") existing.errors++;
      if (s.status === "ERROR" && existing.example.status !== "ERROR") {
        existing.example = {
          span_id: s.id,
          status: s.status,
          input_preview: s.input_preview,
          output_preview: s.output_preview,
        };
      }
      toolCounts.set(s.name, existing);
    }
  }

  let finalResponsePreview = "";
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span.span_type === "LLM_GENERATION" && span.output_preview) {
      finalResponsePreview = span.output_preview;
      break;
    }
  }

  const summary: RunOutline["summary"] = {
    span_type_counts,
    tool_calls: {
      total: totalToolCalls,
      by_name: Array.from(toolCounts.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
    final_response_preview: finalResponsePreview,
  };

  const eventTypes = getDrizzleDb()
    .select({ type: schema.live_events.type, cnt: count() })
    .from(schema.live_events)
    .where(eq(schema.live_events.trace_id, runId))
    .groupBy(schema.live_events.type)
    .all();
  const eventBounds = getDrizzleDb()
    .select({
      cnt: count(),
      first_ts: drizzleSql<number | null>`MIN(${schema.live_events.timestamp})`,
      last_ts: drizzleSql<number | null>`MAX(${schema.live_events.timestamp})`,
    })
    .from(schema.live_events)
    .where(eq(schema.live_events.trace_id, runId))
    .get() as { cnt: number; first_ts: number | null; last_ts: number | null };

  const types = { text_delta: 0, reasoning_delta: 0, tool_start: 0, tool_result: 0 };
  for (const row of eventTypes) {
    if (row.type in types) (types as any)[row.type] = row.cnt;
  }

  const errorRows = getDrizzleDb()
    .select({
      id: schema.spans.id,
      name: schema.spans.name,
      start_time_ms: schema.spans.start_time_ms,
      output_payload: schema.spans.output_payload,
    })
    .from(schema.spans)
    .where(and(eq(schema.spans.run_id, runId), eq(schema.spans.status, "ERROR")))
    .orderBy(asc(schema.spans.start_time_ms))
    .limit(50)
    .all();

  const errors = errorRows.map((r) => ({
    span_id: r.id,
    name: r.name,
    ts: r.start_time_ms ?? 0,
    first_line_of_output: firstLine(r.output_payload),
  }));

  // detectSubAgents only reads id / parent_span_id / name / span_type / status /
  // start_time_ms / end_time_ms / duration_ms / model / input_tokens / output_tokens —
  // all already projected into rawSpans. Reuse it instead of issuing a SELECT * that
  // would pull the fat input_payload / output_payload columns we worked to avoid.
  const sub_agents: RunOutline["sub_agents"] = [];
  for (const sa of detectSubAgents(rawSpans as any)) {
    sub_agents.push({ root_span_id: sa.root_span_id, name: sa.name, span_count: sa.span_ids.length });
  }

  const annotations = getDrizzleDb()
    .select()
    .from(schema.annotations)
    .where(eq(schema.annotations.run_id, runId))
    .orderBy(asc(schema.annotations.created_at))
    .all();

  return {
    run: run as Record<string, unknown>,
    summary,
    spans,
    live_events: { count: eventBounds.cnt, first_ts: eventBounds.first_ts, last_ts: eventBounds.last_ts, types },
    sub_agents,
    annotations: annotations as unknown[],
    errors,
  };
}

export interface ListSpansOpts {
  filter?: {
    span_type?: string;
    status?: string;
    name?: string;
    name_regex?: string;
    model?: string;
    parent_span_id?: string;
    has_payload_match?: string;
    min_duration_ms?: number;
    min_tokens?: number;
  };
  sort?: "start_asc" | "start_desc" | "duration_desc" | "tokens_desc";
  limit?: number;
  offset?: number;
  payload_preview_chars?: number;
}

export interface SpanSkeleton {
  id: string;
  parent_id: string | null;
  name: string;
  span_type: string | null;
  status: string;
  start_time_ms: number;
  duration_ms: number;
  tokens: { in: number; out: number };
  model: string | null;
  input_chars: number;
  output_chars: number;
  input_preview: string;
  output_preview: string;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

export function listSpansFiltered(runId: string, opts: ListSpansOpts = {}): SpanSkeleton[] {
  const cap = Math.max(0, Math.min(400, (opts.payload_preview_chars ?? 0) | 0));
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  const where: string[] = ["run_id = ?"];
  const params: any[] = [runId];
  const f = opts.filter ?? {};

  if (f.span_type) { where.push("span_type = ?"); params.push(f.span_type); }
  if (f.status) { where.push("status = ?"); params.push(f.status); }
  if (f.name) { where.push("LOWER(name) LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(f.name.toLowerCase())}%`); }
  if (f.model) { where.push("model = ?"); params.push(f.model); }
  if (f.parent_span_id) { where.push("parent_span_id = ?"); params.push(f.parent_span_id); }
  if (f.has_payload_match) {
    where.push(`(LOWER(COALESCE(input_payload,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(output_payload,'')) LIKE ? ESCAPE '\\')`);
    const pat = `%${escapeLike(f.has_payload_match.toLowerCase())}%`;
    params.push(pat, pat);
  }
  if (typeof f.min_duration_ms === "number") { where.push("duration_ms >= ?"); params.push(f.min_duration_ms); }
  if (typeof f.min_tokens === "number") {
    where.push("(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) >= ?");
    params.push(f.min_tokens);
  }

  // Lookup is `as Record<string, string>` so an out-of-enum `sort` (e.g. from a
  // hand-rolled REST query) returns `undefined` cleanly and falls back to the
  // default — instead of producing `ORDER BY undefined`, which SQLite would
  // bubble up as `no such column: undefined` and the REST handler would
  // surface as a 500.
  const orderBy = (({
    start_asc: "start_time_ms ASC",
    start_desc: "start_time_ms DESC",
    duration_desc: "duration_ms DESC",
    tokens_desc: "(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) DESC",
  } as const) as Record<string, string>)[opts.sort ?? "start_asc"] ?? "start_time_ms ASC";

  const sql = `
    SELECT id, parent_span_id, name, span_type, status,
           start_time_ms, end_time_ms, duration_ms,
           input_tokens, output_tokens, model,
           SUBSTR(COALESCE(input_payload, ''), 1, ?) AS input_head,
           LENGTH(COALESCE(input_payload, '')) AS input_chars,
           SUBSTR(COALESCE(output_payload, ''), 1, ?) AS output_head,
           LENGTH(COALESCE(output_payload, '')) AS output_chars
    FROM spans
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const rows = rawQuery(sql).all(cap + 1, cap + 1, ...params, limit, offset) as any[];

  const filtered = f.name_regex
    ? rows.filter((r) => {
        try { return new RegExp(f.name_regex!, "i").test(r.name); } catch { return false; }
      })
    : rows;

  return filtered.map((s: any) => ({
    id: s.id,
    parent_id: s.parent_span_id ?? null,
    name: s.name,
    span_type: s.span_type,
    status: s.status ?? "UNSET",
    start_time_ms: s.start_time_ms,
    duration_ms: s.duration_ms ?? 0,
    tokens: { in: s.input_tokens ?? 0, out: s.output_tokens ?? 0 },
    model: s.model,
    input_chars: s.input_chars,
    output_chars: s.output_chars,
    input_preview: cap > 0 ? (s.input_chars > cap ? s.input_head.slice(0, cap) + "…" : s.input_head) : "",
    output_preview: cap > 0 ? (s.output_chars > cap ? s.output_head.slice(0, cap) + "…" : s.output_head) : "",
  }));
}

export interface SearchRunOpts {
  pattern: string;
  regex?: boolean;
  case_sensitive?: boolean;
  scope?: ("span_input" | "span_output" | "span_attributes" | "live_event")[];
  span_type?: string;
  context_chars?: number;
  max_matches?: number;
}

export interface SearchMatch {
  span_id: string | null;
  span_name: string | null;
  scope: "span_input" | "span_output" | "span_attributes" | "live_event";
  match_range: [number, number];
  snippet: string;
  payload_total_chars: number;
}

// Pragmatic v1: longest run of word chars in the regex source. SQL prefilter
// uses this as a LIKE needle to skip rows that can't possibly match. Skipped
// when too short to be selective.
function longestLiteral(re: string): string {
  let best = "";
  for (const m of re.matchAll(/[A-Za-z0-9_]+/g)) {
    if (m[0].length > best.length) best = m[0];
  }
  return best;
}

function buildSnippet(text: string, start: number, end: number, ctx: number): string {
  const a = Math.max(0, start - ctx);
  const b = Math.min(text.length, end + ctx);
  const head = a > 0 ? "…" : "";
  const tail = b < text.length ? "…" : "";
  return head + text.slice(a, start) + "<<MATCH>>" + text.slice(start, end) + "<<END>>" + text.slice(end, b) + tail;
}

export function searchRun(runId: string, opts: SearchRunOpts): { matches: SearchMatch[]; truncated: boolean } {
  const ctx = Math.max(0, Math.min(400, opts.context_chars ?? 80));
  const cap = Math.max(1, Math.min(200, opts.max_matches ?? 50));
  const scopes = new Set(opts.scope ?? ["span_input", "span_output", "span_attributes", "live_event"]);
  const PER_PAYLOAD_CAP = 10;
  const ci = !opts.case_sensitive;

  let matcher: (text: string) => Array<[number, number]>;
  if (opts.regex) {
    let re: RegExp;
    try { re = new RegExp(opts.pattern, ci ? "gi" : "g"); }
    catch (err: any) { throw new Error(`invalid regex: ${err.message}`); }
    matcher = (text) => {
      const out: Array<[number, number]> = [];
      let m: RegExpExecArray | null;
      // Fresh RegExp per text so lastIndex doesn't leak across payloads.
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(text))) {
        out.push([m.index, m.index + m[0].length]);
        // Avoid infinite loops on zero-width matches like ^ or \b.
        if (m[0].length === 0) r.lastIndex++;
        if (out.length >= PER_PAYLOAD_CAP) break;
      }
      return out;
    };
  } else {
    const needle = ci ? opts.pattern.toLowerCase() : opts.pattern;
    matcher = (text) => {
      const out: Array<[number, number]> = [];
      const hay = ci ? text.toLowerCase() : text;
      let from = 0;
      while (out.length < PER_PAYLOAD_CAP) {
        const idx = hay.indexOf(needle, from);
        if (idx === -1) break;
        out.push([idx, idx + needle.length]);
        from = idx + Math.max(1, needle.length);
      }
      return out;
    };
  }

  const likeNeedle = opts.regex ? longestLiteral(opts.pattern) : opts.pattern;
  const usePrefilter = likeNeedle.length >= 2;
  const likePat = usePrefilter ? `%${escapeLike(ci ? likeNeedle.toLowerCase() : likeNeedle)}%` : null;

  const matches: SearchMatch[] = [];
  let truncated = false;

  // Span scopes
  const spanWhere: string[] = ["run_id = ?"];
  const spanParams: any[] = [runId];
  if (opts.span_type) { spanWhere.push("span_type = ?"); spanParams.push(opts.span_type); }
  if (usePrefilter) {
    const conds: string[] = [];
    if (scopes.has("span_input")) { conds.push("LOWER(COALESCE(input_payload,'')) LIKE ? ESCAPE '\\'"); spanParams.push(likePat); }
    if (scopes.has("span_output")) { conds.push("LOWER(COALESCE(output_payload,'')) LIKE ? ESCAPE '\\'"); spanParams.push(likePat); }
    if (scopes.has("span_attributes")) { conds.push("LOWER(COALESCE(attributes,'')) LIKE ? ESCAPE '\\'"); spanParams.push(likePat); }
    if (conds.length) spanWhere.push(`(${conds.join(" OR ")})`);
  }

  if (scopes.has("span_input") || scopes.has("span_output") || scopes.has("span_attributes")) {
    const rows = rawQuery(`
      SELECT id, name, input_payload, output_payload, attributes
      FROM spans WHERE ${spanWhere.join(" AND ")}
      ORDER BY start_time_ms ASC
    `).all(...spanParams) as any[];

    outer: for (const r of rows) {
      for (const [scope, col] of [
        ["span_input", "input_payload"],
        ["span_output", "output_payload"],
        ["span_attributes", "attributes"],
      ] as const) {
        if (!scopes.has(scope)) continue;
        const text = (r as any)[col] ?? "";
        if (!text) continue;
        for (const [s, e] of matcher(text)) {
          matches.push({
            span_id: r.id, span_name: r.name, scope,
            match_range: [s, e],
            snippet: buildSnippet(text, s, e, ctx),
            payload_total_chars: text.length,
          });
          if (matches.length >= cap) { truncated = true; break outer; }
        }
      }
    }
  }

  // Live event scope
  if (scopes.has("live_event") && matches.length < cap) {
    const eventParams: any[] = [runId];
    let eventWhere = "trace_id = ?";
    if (usePrefilter) {
      eventWhere += " AND LOWER(COALESCE(content,'')) LIKE ? ESCAPE '\\'";
      eventParams.push(likePat);
    }
    const rows = rawQuery(
      `SELECT id, span_id, content FROM live_events WHERE ${eventWhere} ORDER BY id ASC`
    ).all(...eventParams) as any[];
    outer: for (const r of rows) {
      const text = r.content ?? "";
      if (!text) continue;
      for (const [s, e] of matcher(text)) {
        matches.push({
          span_id: r.span_id ?? null, span_name: null, scope: "live_event",
          match_range: [s, e],
          snippet: buildSnippet(text, s, e, ctx),
          payload_total_chars: text.length,
        });
        if (matches.length >= cap) { truncated = true; break outer; }
      }
    }
  }

  return { matches, truncated };
}

function spanRowToContextSkeleton(s: any) {
  return {
    id: s.id,
    parent_id: s.parent_span_id ?? null,
    name: s.name,
    span_type: s.span_type,
    status: s.status ?? "UNSET",
    start_time_ms: s.start_time_ms,
    duration_ms: s.duration_ms ?? 0,
    tokens: { in: s.input_tokens ?? 0, out: s.output_tokens ?? 0 },
    model: s.model,
  };
}

export function getSpanContext(
  spanId: string,
  opts: { before?: number; after?: number; includeParent?: boolean } = {},
) {
  const before = Math.max(0, opts.before ?? 2);
  const after = Math.max(0, opts.after ?? 2);
  const includeParent = opts.includeParent ?? true;
  const target = getDrizzleDb()
    .select()
    .from(schema.spans)
    .where(eq(schema.spans.id, spanId))
    .limit(1)
    .get() as any;
  if (!target) return null;

  // Single query handles both root and non-root targets: when parent_span_id is
  // NULL, the (`= ?`) branch fails on NULL comparison and we fall through to
  // the IS NULL branch; when it's a value, the IS NOT NULL guard activates the
  // equality branch and disables the NULL branch.
  const siblingParentFilter = target.parent_span_id
    ? eq(schema.spans.parent_span_id, target.parent_span_id)
    : isNull(schema.spans.parent_span_id);
  const siblings = getDrizzleDb()
    .select()
    .from(schema.spans)
    .where(and(eq(schema.spans.run_id, target.run_id), siblingParentFilter))
    .orderBy(asc(schema.spans.start_time_ms))
    .all() as any[];

  const idx = siblings.findIndex((s) => s.id === spanId);
  const beforeRows = idx >= 0 ? siblings.slice(Math.max(0, idx - before), idx) : [];
  const afterRows = idx >= 0 ? siblings.slice(idx + 1, idx + 1 + after) : [];

  let parent: ReturnType<typeof spanRowToContextSkeleton> | undefined;
  if (includeParent && target.parent_span_id) {
    const p = getDrizzleDb()
      .select()
      .from(schema.spans)
      .where(eq(schema.spans.id, target.parent_span_id))
      .limit(1)
      .get() as any;
    if (p) parent = spanRowToContextSkeleton(p);
  }

  return {
    target: spanRowToContextSkeleton(target),
    before: beforeRows.map((s) => spanRowToContextSkeleton(s)),
    after: afterRows.map((s) => spanRowToContextSkeleton(s)),
    parent,
  };
}

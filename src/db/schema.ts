import { asc, desc, sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, sqliteView, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    event_id: text("event_id"),
    name: text("name"),
    event_name: text("event_name"),
    user_id: text("user_id"),
    convo_id: text("convo_id"),
    started_at: integer("started_at").notNull(),
    last_updated_at: integer("last_updated_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [
    index("idx_runs_last_updated").on(table.last_updated_at),
    index("idx_runs_event_id").on(table.event_id).where(sql`${table.event_id} IS NOT NULL`),
  ],
);

export const spans = sqliteTable(
  "spans",
  {
    id: text("id").primaryKey(),
    run_id: text("run_id").notNull().references(() => runs.id),
    parent_span_id: text("parent_span_id"),
    name: text("name").notNull(),
    span_type: text("span_type"),
    status: text("status").default("UNSET"),
    input_payload: text("input_payload"),
    output_payload: text("output_payload"),
    start_time_ms: real("start_time_ms"),
    end_time_ms: real("end_time_ms"),
    duration_ms: real("duration_ms"),
    model: text("model"),
    provider: text("provider"),
    input_tokens: integer("input_tokens"),
    output_tokens: integer("output_tokens"),
    attributes: text("attributes"),
  },
  (table) => [
    index("idx_spans_run_id").on(table.run_id),
    index("idx_spans_parent").on(table.parent_span_id),
  ],
);

export const live_events = sqliteTable(
  "live_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trace_id: text("trace_id").notNull(),
    span_id: text("span_id"),
    type: text("type").notNull(),
    content: text("content"),
    timestamp: integer("timestamp").notNull(),
    metadata: text("metadata"),
  },
  (table) => [index("idx_live_trace").on(table.trace_id, table.timestamp)],
);

export const saved_run_cache = sqliteTable("saved_run_cache", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
});

export const saved_events = sqliteTable(
  "saved_events",
  {
    id: text("id").primaryKey(),
    event_name: text("event_name").notNull(),
    user_id: text("user_id"),
    convo_id: text("convo_id"),
    timestamp: text("timestamp").notNull(),
    user_input: text("user_input"),
    assistant_output: text("assistant_output"),
    signals: text("signals"),
    properties: text("properties"),
    saved_at: integer("saved_at").notNull(),
    summary: text("summary"),
    source: text("source"),
    folder: text("folder"),
  },
  (table) => [
    index("idx_saved_events_saved_at").on(desc(table.saved_at)),
    index("idx_saved_events_folder").on(table.folder),
  ],
);

export const saved_folders = sqliteTable("saved_folders", {
  name: text("name").primaryKey(),
  color: text("color").notNull(),
  created_at: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    active: integer("active").notNull(),
    created_at: integer("created_at").notNull(),
    deactivated_at: integer("deactivated_at"),
  },
  (table) => [index("idx_sessions_active_created").on(table.active, desc(table.created_at))],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull().references(() => sessions.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    run_id: text("run_id"),
    state: text("state", { enum: ["pending", "delivered", "processing", "done", "error", "timeout"] }).notNull(),
    created_at: integer("created_at").notNull(),
    state_updated_at: integer("state_updated_at").notNull(),
  },
  (table) => [
    index("idx_messages_session_created").on(table.session_id, asc(table.created_at)),
    index("idx_messages_state").on(table.state, table.state_updated_at),
  ],
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: text("id").primaryKey(),
    run_id: text("run_id").notNull(),
    span_id: text("span_id"),
    kind: text("kind", { enum: ["issue", "good", "note"] }).notNull(),
    note: text("note"),
    source: text("source", { enum: ["user", "claude-code", "codex"] }).notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_annotations_run").on(table.run_id),
    index("idx_annotations_span").on(table.span_id).where(sql`${table.span_id} IS NOT NULL`),
  ],
);

export const steering_events = sqliteTable(
  "steering_events",
  {
    id: text("id").primaryKey(),
    observed_run_id: text("observed_run_id").notNull(),
    observer_run_id: text("observer_run_id"),
    target_span_id: text("target_span_id"),
    target_subagent_span_id: text("target_subagent_span_id"),
    action: text("action").notNull(),
    status: text("status").notNull(),
    message: text("message"),
    before_prompt: text("before_prompt"),
    after_prompt: text("after_prompt"),
    reason: text("reason"),
    source: text("source").notNull(),
    confidence: real("confidence"),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_steering_observed").on(table.observed_run_id, desc(table.created_at)),
    index("idx_steering_observer").on(table.observer_run_id).where(sql`${table.observer_run_id} IS NOT NULL`),
    index("idx_steering_target_span").on(table.target_span_id).where(sql`${table.target_span_id} IS NOT NULL`),
    index("idx_steering_target_subagent").on(table.target_subagent_span_id).where(sql`${table.target_subagent_span_id} IS NOT NULL`),
  ],
);

export const runs_with_hints = sqliteView("runs_with_hints", {
  id: text("id"),
  event_id: text("event_id"),
  name: text("name"),
  event_name: text("event_name"),
  user_id: text("user_id"),
  convo_id: text("convo_id"),
  started_at: integer("started_at"),
  last_updated_at: integer("last_updated_at"),
  metadata: text("metadata"),
  model: text("model"),
  finished: integer("finished"),
  span_count: integer("span_count"),
  live_event_count: integer("live_event_count"),
  payload_total_chars: integer("payload_total_chars"),
}).as(sql`
  SELECT
    r.*,
    (SELECT s.model FROM spans s WHERE s.run_id = r.id AND s.model IS NOT NULL LIMIT 1) AS model,
    (SELECT CASE WHEN COUNT(*) > 0
                  AND COUNT(*) = COUNT(CASE WHEN s.status IN ('OK','ERROR') THEN 1 END)
                 THEN 1 ELSE 0 END
     FROM spans s WHERE s.run_id = r.id AND s.parent_span_id IS NULL) AS finished,
    (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id) AS span_count,
    (SELECT COUNT(*) FROM live_events e WHERE e.trace_id = r.id) AS live_event_count,
    (SELECT COALESCE(SUM(LENGTH(COALESCE(s.input_payload, '')) + LENGTH(COALESCE(s.output_payload, ''))), 0)
     FROM spans s WHERE s.run_id = r.id) AS payload_total_chars
  FROM runs r
`);

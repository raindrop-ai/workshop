import { randomUUID } from "crypto";
import { asc, desc, eq, or } from "drizzle-orm";
import { getDrizzleDb } from "./db";
import { steering_events } from "./db/schema";

export type SteeringAction = "nudge" | "system_prompt_update" | "stop" | "restart" | "continue" | "note";
export type SteeringStatus = "proposed" | "mock_applied" | "applied" | "acknowledged" | "dismissed" | "failed";

export interface SteeringEvent {
  id: string;
  observed_run_id: string;
  observer_run_id: string | null;
  target_span_id: string | null;
  target_subagent_span_id: string | null;
  action: SteeringAction;
  status: SteeringStatus;
  message: string | null;
  before_prompt: string | null;
  after_prompt: string | null;
  reason: string | null;
  source: string;
  confidence: number | null;
  created_at: number;
}

export interface CreateSteeringEventInput {
  observed_run_id: string;
  observer_run_id?: string | null;
  target_span_id?: string | null;
  target_subagent_span_id?: string | null;
  action: SteeringAction;
  status?: SteeringStatus;
  message?: string | null;
  before_prompt?: string | null;
  after_prompt?: string | null;
  reason?: string | null;
  source?: string | null;
  confidence?: number | null;
}

const ACTIONS: ReadonlySet<SteeringAction> = new Set([
  "nudge",
  "system_prompt_update",
  "stop",
  "restart",
  "continue",
  "note",
]);

const STATUSES: ReadonlySet<SteeringStatus> = new Set([
  "proposed",
  "mock_applied",
  "applied",
  "acknowledged",
  "dismissed",
  "failed",
]);

export class InvalidSteeringEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSteeringEventError";
  }
}

function optionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rejectPlaceholder(label: string, value: string | null): void {
  if (!value) return;
  if (/^<[^>]+>$/.test(value)) {
    throw new InvalidSteeringEventError(`${label} cannot be a placeholder`);
  }
}

function normalizedConfidence(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) throw new InvalidSteeringEventError("confidence must be finite");
  return Math.max(0, Math.min(1, value));
}

export function createSteeringEvent(input: CreateSteeringEventInput): SteeringEvent {
  const observedRunId = optionalString(input.observed_run_id);
  if (!observedRunId) throw new InvalidSteeringEventError("observed_run_id is required");
  if (!ACTIONS.has(input.action)) throw new InvalidSteeringEventError(`invalid action: ${input.action}`);
  const status = input.status ?? "mock_applied";
  if (!STATUSES.has(status)) throw new InvalidSteeringEventError(`invalid status: ${status}`);
  const targetSpanId = optionalString(input.target_span_id);
  const targetSubagentSpanId = optionalString(input.target_subagent_span_id);
  const observerRunId = optionalString(input.observer_run_id);
  rejectPlaceholder("observer_run_id", observerRunId);
  rejectPlaceholder("target_span_id", targetSpanId);
  rejectPlaceholder("target_subagent_span_id", targetSubagentSpanId);
  const source = optionalString(input.source) ?? "external-observer";
  if (source === "opencode-observer" && (input.action === "continue" || input.action === "note")) {
    throw new InvalidSteeringEventError("opencode-observer steering events must be corrective");
  }

  const row: SteeringEvent = {
    id: randomUUID(),
    observed_run_id: observedRunId,
    observer_run_id: observerRunId,
    target_span_id: targetSpanId,
    target_subagent_span_id: targetSubagentSpanId,
    action: input.action,
    status,
    message: optionalString(input.message),
    before_prompt: optionalString(input.before_prompt),
    after_prompt: optionalString(input.after_prompt),
    reason: optionalString(input.reason),
    source,
    confidence: normalizedConfidence(input.confidence),
    created_at: Date.now(),
  };
  getDrizzleDb().insert(steering_events).values(row).run();
  return row;
}

export function listSteeringEventsForRun(runId: string): SteeringEvent[] {
  return getDrizzleDb()
    .select()
    .from(steering_events)
    .where(or(eq(steering_events.observed_run_id, runId), eq(steering_events.observer_run_id, runId)))
    .orderBy(asc(steering_events.created_at), asc(steering_events.id))
    .all() as SteeringEvent[];
}

export function listObserverRunsForRun(runId: string): string[] {
  const rows = getDrizzleDb()
    .select({ observer_run_id: steering_events.observer_run_id })
    .from(steering_events)
    .where(eq(steering_events.observed_run_id, runId))
    .orderBy(desc(steering_events.created_at))
    .all();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.observer_run_id) seen.add(row.observer_run_id);
  }
  return [...seen];
}

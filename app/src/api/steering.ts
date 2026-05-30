import { apiJson, jsonInit } from "./request";
import type { Run } from "../utils/types";

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

export interface SteeringBroadcast {
  op: "insert";
  observed_run_id: string;
  observer_run_id: string | null;
  target_span_id: string | null;
  target_subagent_span_id: string | null;
  event: SteeringEvent;
}

export interface RunSteeringData {
  events: SteeringEvent[];
  observerRunIds: string[];
  observerRuns: Run[];
}

export async function getRunSteering(runId: string): Promise<RunSteeringData> {
  return apiJson<RunSteeringData>(`/api/runs/${encodeURIComponent(runId)}/steering`);
}

export async function createSteeringEvent(input: {
  observedRunId: string;
  observerRunId?: string;
  targetSpanId?: string;
  targetSubagentSpanId?: string;
  action: SteeringAction;
  status?: SteeringStatus;
  message?: string;
  beforePrompt?: string;
  afterPrompt?: string;
  reason?: string;
  source?: string;
  confidence?: number;
}): Promise<{ ok: true; mocked: boolean; event: SteeringEvent }> {
  return apiJson<{ ok: true; mocked: boolean; event: SteeringEvent }>("/api/steering/events", jsonInit("POST", input));
}

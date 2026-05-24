import { apiJson, apiJsonOrNull, jsonInit } from "./request";

type Role = "user" | "assistant";

export type ClaudeChatMessageBlock =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input_preview?: string; output_preview?: string; ok?: boolean }
  | { type: "thinking"; text: string };

export interface ClaudeChatMessage {
  id: string;
  role: Role;
  content: string;
  blocks?: ClaudeChatMessageBlock[];
  timestamp: string | null;
  error?: string;
}

export interface ClaudeSessionSummary {
  id: string;
  title?: string | null;
  created_at: string | null;
  updated_at: string | null;
  message_count: number;
  loaded_message_count?: number;
  messages_truncated?: boolean;
  last_prompt: string | null;
  preview: string | null;
  cwd?: string;
}

export interface ClaudeSessionDetail extends ClaudeSessionSummary {
  messages: ClaudeChatMessage[];
}

export interface ClaudeAskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

export interface ClaudeAskUserQuestion {
  id: string;
  session_id: string;
  tool_use_id: string;
  questions: ClaudeAskQuestion[];
  created_at: string;
}

export interface AgentLoadout {
  tools?: string[];
  mcps?: string[];
  skills?: string[];
  plugins?: string[];
  slash_commands?: string[];
  model?: string;
}

export type AgentStreamEvent =
  | { type: "text"; content: string }
  | ({ type: "loadout" } & AgentLoadout)
  | { type: "error"; content: string }
  | { type: "tool_start"; id: string; name: string; input_preview?: string }
  | { type: "tool_finish"; id: string; ok: boolean; output_preview?: string }
  | { type: "thinking_delta"; content: string }
  | { type: "subagent_start"; parent_id: string; subagent: string }
  | { type: "provider_session"; sessionId: string }
  | { type: "done" };

export interface ClaudeMessageStream {
  client_message_id?: string;
  session_id?: string | null;
  event?: AgentStreamEvent;
}

export interface SendAgentMessageResponse {
  session_id?: string;
  session?: ClaudeSessionDetail;
  text?: string;
}

export async function listAgentSessions(): Promise<ClaudeSessionSummary[]> {
  return apiJsonOrNull<ClaudeSessionSummary[]>("/api/agent/sessions").then((sessions) => sessions ?? []);
}

export async function getAgentSession(id: string): Promise<ClaudeSessionDetail> {
  return apiJson<ClaudeSessionDetail>(`/api/agent/sessions/${encodeURIComponent(id)}`);
}

export async function getAgentLoadout(): Promise<AgentLoadout | null> {
  return apiJsonOrNull<AgentLoadout>("/api/agent/loadout");
}

export async function sendAgentMessage(body: {
  content: string;
  session_id: string | null;
  run_id: string | null;
  client_message_id: string;
}): Promise<SendAgentMessageResponse> {
  return apiJson<SendAgentMessageResponse>("/api/agent/messages", jsonInit("POST", body));
}

export async function answerAskUserQuestion(id: string, answers: Record<string, string>): Promise<void> {
  await apiJson<{ ok?: boolean }>(`/api/claude/ask-user-question/${encodeURIComponent(id)}/answer`, jsonInit("POST", { answers }));
}

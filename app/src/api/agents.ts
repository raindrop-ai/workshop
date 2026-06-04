import { apiJson, apiJsonOrNull, jsonInit } from "./request";
import { isAgentProvider, type AgentProviderId } from "../utils/agent-provider";

export interface AgentEntry {
  url?: string;
  cwd?: string;
  command?: string;
  lastSeenPort?: number;
  input?: Record<string, string>;
  prefillFromTrace?: Record<string, string>;
  contextFromTrace?: Record<string, string>;
}

export type AgentsRegistry = Record<string, AgentEntry>;
export type AgentsHealth = Record<string, "online" | "offline">;
export type AgentConnectionState = "green" | "amber" | "gray";

export interface AgentConnectionStatus {
  state: AgentConnectionState;
  session_id?: string;
}

export async function getAgents(): Promise<AgentsRegistry> {
  return apiJsonOrNull<AgentsRegistry>("/api/agents").then((agents) => agents ?? {});
}

export async function getAgentsHealth(): Promise<AgentsHealth> {
  return apiJsonOrNull<AgentsHealth>("/api/agents/health").then((health) => health ?? {});
}

export async function saveAgents(agents: AgentsRegistry): Promise<void> {
  await apiJson("/api/agents", jsonInit("PUT", agents));
}

export async function getAgentProvider(): Promise<AgentProviderId> {
  const body = await apiJsonOrNull<{ provider?: unknown }>("/api/agent/provider");
  return isAgentProvider(body?.provider) ? body.provider : "claude";
}

export async function setAgentProvider(provider: AgentProviderId): Promise<void> {
  await apiJson("/api/agent/provider", jsonInit("POST", { provider }));
}

export async function getAgentStatus(): Promise<{ connected: boolean; cwd?: string; provider?: string }> {
  return apiJson("/api/status");
}

export async function getAgentConnectionStatus(): Promise<AgentConnectionStatus> {
  const body = await apiJsonOrNull<{ agent?: AgentConnectionStatus; claude_code?: AgentConnectionStatus }>("/api/status");
  return body?.agent ?? body?.claude_code ?? { state: "gray" };
}

export async function getAnthropicModels(): Promise<string[]> {
  const body = await apiJsonOrNull<{ models?: unknown[] }>("/api/models/anthropic");
  return Array.isArray(body?.models)
    ? body.models.filter((model): model is string => typeof model === "string")
    : [];
}

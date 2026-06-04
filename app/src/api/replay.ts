import { apiJson, jsonInit } from "./request";

export interface ReplayRequest {
  runId: string;
  userMessage?: string;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  contextOverrides?: Record<string, string>;
}

export async function getReplayContext(input: {
  runId: string;
  eventName?: string | null;
}): Promise<Record<string, string>> {
  const body = await apiJson<{ context?: unknown }>("/api/replay/context", jsonInit("POST", {
    runId: input.runId,
    eventName: input.eventName,
  }));
  if (!body.context || typeof body.context !== "object" || Array.isArray(body.context)) return {};
  return Object.fromEntries(Object.entries(body.context).map(([key, value]) => [key, String(value)]));
}

export async function startReplayStream(config: ReplayRequest, signal: AbortSignal): Promise<Response> {
  return fetch("/api/replay", jsonInit("POST", {
    runId: config.runId,
    mode: "local",
    userMessage: config.userMessage,
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations,
    contextOverrides: config.contextOverrides,
  }, { signal }));
}

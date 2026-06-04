import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAgents, getAgentsHealth, getAnthropicModels, type AgentEntry, type AgentsHealth, type AgentsRegistry } from "../api/agents";
import { useWorkshopEvent } from "./use-workshop-ws";

/**
 * Live view of `~/.raindrop/agents.json` and per-agent `/health` status.
 *
 * Three writers can mutate the registry from outside this React tree:
 *
 *   1. The Settings page UI (`PUT /api/agents`)
 *   2. The `/setup-agent-replay` slash command in Claude Code /
 *      Cursor — runs in a different process, writes the file on disk, then
 *      `curl`s `POST /api/agents/refresh` so we hear about it.
 *   3. A user hand-editing the file in vim, then optionally curl-refreshing.
 *
 * The Workshop server's `agents_updated` WS event covers (1) and (2). For
 * (3) the user has to refresh the page (or curl); we don't `fs.watch` the
 * file because rename-on-write editors make it unreliable on macOS.
 *
 * Returns a snapshot of the registry plus the current health map. Both
 * are kept in sync with whatever the server most recently broadcast.
 */
export type { AgentEntry, AgentsHealth, AgentsRegistry };

export function useAgents() {
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  });
  const healthQuery = useQuery({
    queryKey: ["agents-health"],
    queryFn: getAgentsHealth,
    enabled: Object.keys(agentsQuery.data ?? {}).length > 0,
    refetchInterval: 15000,
  });

  const refetch = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agents"] }),
      queryClient.invalidateQueries({ queryKey: ["agents-health"] }),
    ]);
  }, [queryClient]);

  // Live updates from the server. Both the PUT and refresh handlers in
  // server.ts broadcast `agents_updated`; we re-probe health on the same
  // signal so the dot color is fresh too.
  useWorkshopEvent("agents_updated", (data: { agents?: AgentsRegistry }) => {
    if (data?.agents) queryClient.setQueryData(["agents"], data.agents);
    queryClient.invalidateQueries({ queryKey: ["agents-health"] });
  });

  const agents = agentsQuery.data ?? {};
  const health = useMemo((): Record<string, "online" | "offline" | "checking"> => {
    if (healthQuery.isLoading) {
      return Object.fromEntries(Object.keys(agents).map(name => [name, "checking" as const]));
    }
    return healthQuery.data ?? {};
  }, [agents, healthQuery.data, healthQuery.isLoading]);

  return { agents, health, refetch };
}

/**
 * Convenience wrapper for components that only care about a single
 * eventName ("is *this* agent registered + healthy right now?").
 *
 * Strips the `replay:` prefix that Workshop puts on replay rows so callers
 * can pass `run.event_name` directly.
 */
export function useAgentForEvent(eventName: string | null | undefined) {
  const { agents, health, refetch } = useAgents();
  const name = (eventName ?? "").replace(/^replay:/, "");
  return {
    name,
    config: name ? agents[name] ?? null : null,
    configured: !!(name && agents[name]),
    online: !!(name && health[name] === "online"),
    refetch,
  };
}

export function useAnthropicModels() {
  return useQuery({
    queryKey: ["anthropic-models"],
    queryFn: getAnthropicModels,
  });
}

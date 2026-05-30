import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRunSteering, type RunSteeringData, type SteeringBroadcast } from "../api/steering";
import { useWorkshopEvent } from "./use-workshop-ws";

const EMPTY_STEERING: RunSteeringData = {
  events: [],
  observerRunIds: [],
  observerRuns: [],
};

export function useSteering(runId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["steering", runId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => getRunSteering(runId!),
    enabled: !!runId,
    initialData: EMPTY_STEERING,
  });

  useWorkshopEvent("steering", (data: SteeringBroadcast) => {
    if (!data || (data.observed_run_id !== runId && data.observer_run_id !== runId)) return;
    queryClient.setQueryData<RunSteeringData>(queryKey, (prev = EMPTY_STEERING) => {
      if (prev.events.some((event) => event.id === data.event.id)) return prev;
      const observerRunIds = data.event.observer_run_id && !prev.observerRunIds.includes(data.event.observer_run_id)
        ? [data.event.observer_run_id, ...prev.observerRunIds]
        : prev.observerRunIds;
      return {
        ...prev,
        observerRunIds,
        events: [...prev.events, data.event].sort((a, b) => a.created_at - b.created_at),
      };
    });
  });

  return query.data ?? EMPTY_STEERING;
}

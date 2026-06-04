import { useQuery } from "@tanstack/react-query";
import { fetchSignals } from "../api/query-api";

export function useQuerySignals(enabled: boolean) {
  return useQuery({
    queryKey: ["query-api", "signals"],
    queryFn: fetchSignals,
    enabled,
  });
}

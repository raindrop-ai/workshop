import { useCallback, useRef, useState } from "react";
import { getRunDetail, listRuns } from "../api/runs";
import { startReplayStream } from "../api/replay";

export type ReplayMode = "local";

export interface ReplayConfig {
  runId: string;
  mode?: ReplayMode;
  userMessage?: string;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  contextOverrides?: Record<string, string>;
}

export interface ReplayProgress {
  iteration: number;
  toolsMocked: number;
  matchStats: { exact: number; ordered: number; name_only: number; fallback: number };
}

export type ReplayState = "idle" | "running" | "complete" | "error" | "cancelled";

export function useReplay(onReplayRunId?: (runId: string) => void) {
  const [state, setState] = useState<ReplayState>("idle");
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ReplayProgress>({
    iteration: 0, toolsMocked: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 },
  });
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onReplayRunIdRef = useRef(onReplayRunId);
  onReplayRunIdRef.current = onReplayRunId;

  const setVisibleReplayRunId = useCallback((runId: string) => {
    setReplayRunId(runId);
    onReplayRunIdRef.current?.(runId);
  }, []);

  const startReplay = useCallback(async (config: ReplayConfig) => {
    setState("running");
    setError(null);
    setReplayRunId(null);
    setProgress({ iteration: 0, toolsMocked: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });

    const abort = new AbortController();
    abortRef.current = abort;
    const startTime = Date.now();
    let foundRunId: string | null = null;
    let placeholderRunId: string | null = null;
    let hadError = false;

    // Poll for spans on the replay run. For local agent mode, OTLP spans are
    // reparented directly to the placeholder run via the replayRunId metadata.
    // For other modes, the OTLP run may be a different ID, so also check for
    // replay runs that appeared after we started.
    const pollInterval = setInterval(async () => {
      if (foundRunId || abort.signal.aborted) { clearInterval(pollInterval); return; }
      try {
        if (placeholderRunId) {
          try {
            const detail = await getRunDetail(placeholderRunId);
            if (detail.spans && detail.spans.length > 0) {
              foundRunId = placeholderRunId;
              setVisibleReplayRunId(placeholderRunId);
              clearInterval(pollInterval);
              return;
            }
          } catch {}
        }

        const runs = await listRuns();
        for (const r of runs) {
          if (!(r.event_name ?? "").startsWith("replay:")) continue;
          if (r.last_updated_at < startTime - 5000) continue;
          if (r.id === placeholderRunId) continue;
          try {
            const detail = await getRunDetail(r.id);
            if (detail.spans && detail.spans.length > 0) {
              foundRunId = r.id;
              setVisibleReplayRunId(r.id);
              clearInterval(pollInterval);
              return;
            }
          } catch {}
        }
      } catch {}
    }, 800);

    try {
      const resp = await startReplayStream(config, abort.signal);

      if (!resp.ok) {
        clearInterval(pollInterval);
        const err = await resp.text();
        setState("error");
        setError(err);
        return null;
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        clearInterval(pollInterval);
        setState("error");
        setError("Cannot read response stream");
        return null;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);

            // Track the placeholder ID so the poll skips it
            if (event.type === "replay_started" && event.replayRunId) {
              placeholderRunId = event.replayRunId;
            }

            if (event.type === "llm_start") {
              setProgress(p => ({ ...p, iteration: event.iteration }));
            }

            if (event.type === "tool_mocked") {
              setProgress(p => ({
                ...p,
                toolsMocked: p.toolsMocked + 1,
                matchStats: {
                  ...p.matchStats,
                  [event.matchType as keyof typeof p.matchStats]:
                    p.matchStats[event.matchType as keyof typeof p.matchStats] + 1,
                },
              }));
            }

            if (event.type === "error") {
              hadError = true;
              setState("error");
              setError(event.message);
              continue;
            }

            if (event.type === "replay_complete" && !hadError) {
              setState("complete");
              // replay_complete carries the authoritative final run id; an earlier
              // poll-latched id can be stale if adoptRunByEventId merged it away.
              if (event.replayRunId && event.replayRunId !== foundRunId) {
                foundRunId = event.replayRunId;
                setVisibleReplayRunId(event.replayRunId);
              }
              setProgress(p => ({ ...p, iteration: event.iterations, toolsMocked: event.toolCallCount, matchStats: event.matchStats }));
            }
          } catch {}
        }
      }

      clearInterval(pollInterval);
      if (!hadError) setState("complete");
      return foundRunId;
    } catch (err: unknown) {
      clearInterval(pollInterval);
      if (err instanceof DOMException && err.name === "AbortError") {
        setState("cancelled");
        return null;
      }
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [setVisibleReplayRunId]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState("cancelled");
  }, []);

  const reset = useCallback(() => {
    setState("idle");
    setReplayRunId(null);
    setError(null);
    setProgress({ iteration: 0, toolsMocked: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });
  }, []);

  const viewExisting = useCallback((runId: string) => {
    setVisibleReplayRunId(runId);
    setState("complete");
    setError(null);
  }, [setVisibleReplayRunId]);

  return { state, replayRunId, progress, error, startReplay, cancel, reset, viewExisting };
}

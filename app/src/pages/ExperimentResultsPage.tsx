import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { getExperimentResults, type ExperimentDatasetResult, type ExperimentRunPoint, type LangfuseSource } from "../api/research";
import { C, spanColor } from "../utils/colors";

const SOURCES: Array<{ id: LangfuseSource; label: string }> = [
  { id: "prod", label: "Cloud Prod" },
  { id: "onprem", label: "On Prem" },
];

function scoreColor(score: number | null | undefined) {
  if (score == null) return C.fg0;
  if (score >= 70) return C.green;
  if (score >= 50) return C.orange;
  return C.red;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function scoreLabel(score: number | null | undefined) {
  return score == null ? "--" : `${score}%`;
}

function DatasetCard({ dataset }: { dataset: ExperimentDatasetResult }) {
  const latest = dataset.latestRun;
  const color = scoreColor(latest?.score);
  return (
    <div
      className="min-w-0 rounded-lg border p-3"
      style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium" style={{ color: C.fg4 }}>{dataset.name}</div>
          <div className="mt-1 truncate text-[10px] font-mono" style={{ color: C.fg0 }}>{dataset.agent}</div>
        </div>
        <div
          className="flex h-11 min-w-[64px] items-center justify-center rounded-md border text-[18px] font-semibold"
          style={{ color, background: `${color}16`, borderColor: `${color}55` }}
        >
          {scoreLabel(latest?.score)}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] font-mono" style={{ color: C.fg0 }}>
        <div>
          <div style={{ color: C.fg2 }}>{dataset.itemCount}</div>
          items
        </div>
        <div>
          <div style={{ color: C.fg2 }}>{latest?.scored ?? 0}</div>
          scored
        </div>
        <div className="min-w-0">
          <div className="truncate" style={{ color: C.fg2 }}>{latest?.runName ?? "no runs"}</div>
          latest
        </div>
      </div>
    </div>
  );
}

function TrendChart({ points }: { points: ExperimentRunPoint[] }) {
  const colorMap = useMemo(() => new Map<string, string>(), []);
  const scored = points.filter((point) => point.score !== null && point.createdAt);
  const width = 940;
  const height = 300;
  const pad = { left: 42, right: 18, top: 18, bottom: 44 };
  const times = scored.map((point) => new Date(point.createdAt).getTime()).filter((time) => Number.isFinite(time));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const x = (time: number) => {
    if (!Number.isFinite(minTime) || minTime === maxTime) return pad.left + (width - pad.left - pad.right) / 2;
    return pad.left + ((time - minTime) / (maxTime - minTime)) * (width - pad.left - pad.right);
  };
  const y = (score: number) => pad.top + (1 - score / 100) * (height - pad.top - pad.bottom);
  const byAgent = new Map<string, ExperimentRunPoint[]>();
  for (const point of scored) {
    const bucket = byAgent.get(point.agent) ?? [];
    bucket.push(point);
    byAgent.set(point.agent, bucket);
  }
  const agents = [...byAgent.keys()].sort();

  if (scored.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-lg border text-sm" style={{ borderColor: C.border, color: C.fg0 }}>
        No scored experiment runs found yet.
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3" style={{ background: "rgba(255,255,255,0.02)", borderColor: C.border }}>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {agents.map((agent) => (
          <div key={agent} className="flex items-center gap-1.5 text-[10px] font-mono" style={{ color: C.fg1 }}>
            <span className="h-2 w-2 rounded-full" style={{ background: spanColor(agent, colorMap) }} />
            <span>{agent}</span>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto">
        <svg width={width} height={height} role="img" aria-label="Experiment score trend chart">
          {[0, 50, 70, 100].map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="rgba(255,255,255,0.07)" />
              <text x={8} y={y(tick) + 4} fill={C.fg0} fontSize={10} fontFamily="monospace">{tick}%</text>
            </g>
          ))}
          <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="rgba(255,255,255,0.12)" />
          <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke="rgba(255,255,255,0.12)" />
          {agents.map((agent) => {
            const agentPoints = [...(byAgent.get(agent) ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
            const path = agentPoints
              .map((point, index) => `${index === 0 ? "M" : "L"} ${x(new Date(point.createdAt).getTime()).toFixed(1)} ${y(point.score ?? 0).toFixed(1)}`)
              .join(" ");
            const color = spanColor(agent, colorMap);
            return (
              <g key={agent}>
                <path d={path} fill="none" stroke={color} strokeWidth={2} />
                {agentPoints.map((point) => (
                  <g key={`${point.datasetName}-${point.runName}`}>
                    <circle cx={x(new Date(point.createdAt).getTime())} cy={y(point.score ?? 0)} r={3.5} fill={color} />
                    <title>{`${point.agent} · ${point.datasetName}\n${point.runName}\n${scoreLabel(point.score)} · ${formatTime(point.createdAt)}`}</title>
                  </g>
                ))}
              </g>
            );
          })}
          {scored.slice(0, 1).map((point) => (
            <text key="start" x={pad.left} y={height - 16} fill={C.fg0} fontSize={10} fontFamily="monospace">{formatTime(point.createdAt)}</text>
          ))}
          {scored.slice(-1).map((point) => (
            <text key="end" x={width - 170} y={height - 16} fill={C.fg0} fontSize={10} fontFamily="monospace">{formatTime(point.createdAt)}</text>
          ))}
        </svg>
      </div>
    </div>
  );
}

export function ExperimentResultsPage() {
  const [source, setSource] = useState<LangfuseSource>("prod");
  const [query, setQuery] = useState("");
  const [datasets, setDatasets] = useState<ExperimentDatasetResult[]>([]);
  const [series, setSeries] = useState<ExperimentRunPoint[]>([]);
  const [langfuseUrl, setLangfuseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getExperimentResults({ lfEnv: source });
      setDatasets(result.datasets);
      setSeries(result.series);
      setLangfuseUrl(result.langfuseUrl);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [source]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSeries = useMemo(() => {
    if (!normalizedQuery) return series;
    return series.filter((point) =>
      point.agent.toLowerCase().includes(normalizedQuery) ||
      point.datasetName.toLowerCase().includes(normalizedQuery) ||
      point.runName.toLowerCase().includes(normalizedQuery) ||
      point.scoreName.toLowerCase().includes(normalizedQuery)
    );
  }, [normalizedQuery, series]);
  const filteredDatasets = useMemo(() => {
    if (!normalizedQuery) return datasets;
    return datasets
      .map((dataset) => ({
        ...dataset,
        runs: dataset.runs.filter((run) =>
          run.agent.toLowerCase().includes(normalizedQuery) ||
          run.datasetName.toLowerCase().includes(normalizedQuery) ||
          run.runName.toLowerCase().includes(normalizedQuery) ||
          run.scoreName.toLowerCase().includes(normalizedQuery)
        ),
      }))
      .filter((dataset) =>
        dataset.agent.toLowerCase().includes(normalizedQuery) ||
        dataset.name.toLowerCase().includes(normalizedQuery) ||
        dataset.runs.length > 0
      )
      .map((dataset) => ({
        ...dataset,
        latestRun: dataset.runs.find((run) => run.score !== null) ?? dataset.latestRun,
      }));
  }, [datasets, normalizedQuery]);

  return (
    <div className="h-full overflow-auto px-5 py-4" style={{ background: C.bg }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold" style={{ color: C.fg4 }}>Experiment Results</h1>
          <p className="mt-1 text-[12px]" style={{ color: C.fg0 }}>Latest Langfuse dataset scores and experiment trends.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-white/10 bg-white/[0.03] p-0.5">
            {SOURCES.map((item) => (
              <button
                key={item.id}
                className="h-7 rounded px-2.5 text-[11px] font-mono transition-colors"
                style={{ color: source === item.id ? C.fg4 : C.fg0, background: source === item.id ? "rgba(255,255,255,0.10)" : "transparent" }}
                onClick={() => setSource(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {langfuseUrl && (
            <a
              className="flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-mono transition-colors hover:bg-white/10"
              style={{ color: C.fg2 }}
              href={langfuseUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="size-3" />
              Langfuse
            </a>
          )}
          <button
            className="flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-3 text-[11px] font-mono transition-colors hover:bg-white/10"
            style={{ color: C.fg2 }}
            onClick={() => void load()}
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            refresh
          </button>
        </div>
      </div>

      <div className="mb-4 flex max-w-[520px] items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2">
        <Search className="size-3.5" style={{ color: C.fg0 }} />
        <input
          className="h-8 flex-1 bg-transparent text-[12px] outline-none"
          style={{ color: C.fg3 }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search experiments, models, agents..."
        />
      </div>

      {error && (
        <div className="mb-4 rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: "rgba(235,20,20,0.35)", color: C.red }}>
          {error}
        </div>
      )}

      <div className="mb-5">
        <TrendChart points={filteredSeries} />
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-medium" style={{ color: C.fg3 }}>Datasets</h2>
        <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>
          {filteredDatasets.length} datasets · {filteredSeries.length} scored runs
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {filteredDatasets.map((dataset) => <DatasetCard key={dataset.id || dataset.name} dataset={dataset} />)}
      </div>
      {loading && datasets.length === 0 && (
        <div className="mt-8 text-center text-sm" style={{ color: C.fg0 }}>Loading experiment results...</div>
      )}
      {!loading && filteredDatasets.length === 0 && (
        <div className="mt-8 text-center text-sm" style={{ color: C.fg0 }}>No experiments match this search.</div>
      )}
    </div>
  );
}

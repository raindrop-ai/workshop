import { useMemo, useState, type ReactNode } from "react";
import { Check, ExternalLink, Filter, ShieldCheck, X } from "lucide-react";
import { C } from "../utils/colors";

type Difficulty = "easy" | "medium" | "hard";
type DifficultyFilter = "all" | Difficulty;
type FeatureLabel = "workbench" | "health check";
type Siem = "Databricks" | "SumoLogic" | "Google SecOps" | "Crowdstrike NG SIEM" | "Elastic" | "Splunk" | "Sentinel";
type SiemFilter = "All SIEMs" | Siem;
type Result = "pass" | "fail";

interface DetectBenchTask {
  id: string;
  task: string;
  siem: Siem;
  difficulty: Difficulty;
  featureLabel: FeatureLabel;
  requestType: string;
  agent: string;
  dataset: string;
  result: Result;
}

const SIEMS: Siem[] = ["Databricks", "SumoLogic", "Google SecOps", "Crowdstrike NG SIEM", "Elastic", "Splunk", "Sentinel"];

const TASKS: DetectBenchTask[] = [
  { id: "DB-001", task: "Write detections for Artifactory access logs", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-author-agent", dataset: "detection_author_agent/spectrum", result: "pass" },
  { id: "DB-002", task: "Classify first-time AWS KMS Decrypt activity with missing baselines", siem: "Databricks", difficulty: "hard", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/aws", result: "fail" },
  { id: "DB-003", task: "Decide whether O365 legacy auth can be detected from provided fields", siem: "Sentinel", difficulty: "easy", featureLabel: "health check", requestType: "customer request", agent: "detection-review-agent", dataset: "detection_review_agent/o365", result: "pass" },
  { id: "DB-004", task: "Write Google SecOps rule logic for CloudTrail recon aggregation", siem: "Google SecOps", difficulty: "medium", featureLabel: "workbench", requestType: "threat model", agent: "detection-author-agent", dataset: "detection_author_agent/google_secops", result: "pass" },
  { id: "DB-005", task: "Explain why Fortinet VPN conditional auth cannot be implemented strictly", siem: "SumoLogic", difficulty: "hard", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-review-agent", dataset: "detection_review_agent/fortinet", result: "fail" },
  { id: "DB-006", task: "Generate Elastic EQL for a degraded dropper sequence", siem: "Elastic", difficulty: "hard", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/elastic", result: "fail" },
  { id: "DB-007", task: "Validate Sysmon Event ID 8 structural detection coverage", siem: "Crowdstrike NG SIEM", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-validator-agent", dataset: "detection_validator_agent/sysmon", result: "pass" },
  { id: "DB-008", task: "Write detection guidance for Mimecast URL clicked telemetry", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-author-agent", dataset: "detection_author_agent/mimecast", result: "fail" },
  { id: "DB-009", task: "Classify new external IP login as implementable or baseline-only", siem: "Sentinel", difficulty: "medium", featureLabel: "workbench", requestType: "research review", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/identity", result: "pass" },
  { id: "DB-010", task: "Score detection output for S3 GetBucketAcl by IAMUser", siem: "Databricks", difficulty: "easy", featureLabel: "health check", requestType: "judge calibration", agent: "detection-judge-agent", dataset: "detection_judge_agent/aws", result: "pass" },
  { id: "DB-011", task: "Build Defender registry disable detection from Windows logs", siem: "Crowdstrike NG SIEM", difficulty: "medium", featureLabel: "workbench", requestType: "threat model", agent: "detection-author-agent", dataset: "detection_author_agent/defender", result: "pass" },
  { id: "DB-012", task: "Determine whether first-time process hash is practically implementable", siem: "Elastic", difficulty: "hard", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/endpoint", result: "fail" },
  { id: "DB-013", task: "Draft LastPass outside business hours detection and caveats", siem: "SumoLogic", difficulty: "medium", featureLabel: "workbench", requestType: "customer escalation", agent: "detection-author-agent", dataset: "detection_author_agent/lastpass", result: "pass" },
  { id: "DB-014", task: "Health check parser output for DNS beaconing threshold scenario", siem: "Google SecOps", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-parser-agent", dataset: "detection_parser_agent/dns", result: "pass" },
  { id: "DB-015", task: "Translate net.exe Domain Admins behavior into SIEM-agnostic logic", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-modeler-agent", dataset: "detection_modeler_agent", result: "pass" },
  { id: "DB-016", task: "Assess DB audit absent evidence and return logs_missing", siem: "Databricks", difficulty: "easy", featureLabel: "health check", requestType: "customer request", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/database", result: "pass" },
  { id: "DB-017", task: "Write PowerShell EncodedCommand detection with false positive notes", siem: "Sentinel", difficulty: "easy", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/powershell", result: "pass" },
  { id: "DB-018", task: "Model cross-account AssumeRole degraded telemetry requirements", siem: "SumoLogic", difficulty: "hard", featureLabel: "workbench", requestType: "threat model", agent: "detection-modeler-agent", dataset: "detection_modeler_agent/aws", result: "fail" },
  { id: "DB-019", task: "Validate Fortinet VPN auth-failure detection output", siem: "Elastic", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-validator-agent", dataset: "detection_validator_agent/fortinet", result: "pass" },
  { id: "DB-020", task: "Author DGA standalone heuristic with degraded threshold handling", siem: "Google SecOps", difficulty: "hard", featureLabel: "workbench", requestType: "research review", agent: "detection-author-agent", dataset: "detection_author_agent/dns", result: "fail" },
  { id: "DB-021", task: "Judge whether first-login from new country requires unavailable history", siem: "Sentinel", difficulty: "medium", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-judge-agent", dataset: "detection_judge_agent/identity", result: "pass" },
  { id: "DB-022", task: "CreateRemoteThread clean detection with Sysmon source assumptions", siem: "Crowdstrike NG SIEM", difficulty: "medium", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/sysmon", result: "pass" },
  { id: "DB-023", task: "Check CloudTrail AccessDenied spray scoring consistency", siem: "Databricks", difficulty: "easy", featureLabel: "health check", requestType: "judge calibration", agent: "detection-judge-agent", dataset: "detection_judge_agent/aws", result: "pass" },
  { id: "DB-024", task: "Write SIEM-agnostic acceptance criteria for a detection bug", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "Jira bug", agent: "research-review-agent", dataset: "research_review_agent", result: "pass" },
  { id: "DB-025", task: "Map SEP2 Google SecOps dataset fields to benchmark expectations", siem: "Google SecOps", difficulty: "hard", featureLabel: "workbench", requestType: "SIEM migration", agent: "detection-modeler-agent", dataset: "detection_modeler_agent/google_secops", result: "fail" },
];

const difficultyStyle: Record<Difficulty, { color: string; background: string; border: string }> = {
  easy: { color: C.green, background: "rgba(96,227,109,0.12)", border: "rgba(96,227,109,0.34)" },
  medium: { color: C.orange, background: "rgba(240,173,78,0.13)", border: "rgba(240,173,78,0.36)" },
  hard: { color: C.red, background: "rgba(235,20,20,0.13)", border: "rgba(235,20,20,0.36)" },
};

const featureStyle: Record<FeatureLabel, { color: string; background: string; border: string }> = {
  workbench: { color: C.accent, background: "rgba(91,141,239,0.13)", border: "rgba(91,141,239,0.36)" },
  "health check": { color: C.cyan, background: "rgba(79,202,227,0.12)", border: "rgba(79,202,227,0.34)" },
};

function Badge({ children, style }: { children: string; style: { color: string; background: string; border: string } }) {
  return (
    <span
      className="inline-flex h-6 items-center rounded border px-2 text-[10px] font-semibold uppercase"
      style={{ color: style.color, background: style.background, borderColor: style.border }}
    >
      {children}
    </span>
  );
}

function StatTile({ label, value, accent = C.fg3 }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="min-w-[142px] px-1 py-1">
      <div className="text-[34px] font-semibold leading-none" style={{ color: accent }}>{value}</div>
      <div className="mt-1 text-[11px] font-mono uppercase" style={{ color: C.fg0 }}>{label}</div>
    </div>
  );
}

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-lg border p-4" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.10)" }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="font-mono text-[13px] font-semibold tracking-wide" style={{ color: C.fg4 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ScoreTrend() {
  return (
    <svg viewBox="0 0 220 56" className="h-16 w-[220px]" role="img" aria-label="3 month score trend">
      <path d="M0 44 L220 22 L220 56 L0 56 Z" fill="rgba(245,206,78,0.10)" />
      <path d="M 0 44 C 40 42, 72 36, 110 34 S 180 28, 220 22" fill="none" stroke="#F5CE4E" strokeWidth="2" />
    </svg>
  );
}

function ResultCell({ result }: { result: Result }) {
  const passed = result === "pass";
  return (
    <span className="inline-flex items-center gap-1.5 font-mono" style={{ color: passed ? C.green : C.fg0 }}>
      {passed ? <Check className="size-3" /> : <X className="size-3" />}
      {passed ? "Pass" : "Fail"}
    </span>
  );
}

export function DetectBenchPage() {
  const [siemFilter, setSiemFilter] = useState<SiemFilter>("All SIEMs");
  const [difficultyFilter, setDifficultyFilter] = useState<DifficultyFilter>("all");
  const filteredTasks = useMemo(() => {
    return TASKS
      .filter((task) => siemFilter === "All SIEMs" || task.siem === siemFilter)
      .filter((task) => difficultyFilter === "all" || task.difficulty === difficultyFilter)
      .sort((a, b) => SIEMS.indexOf(a.siem) - SIEMS.indexOf(b.siem) || a.id.localeCompare(b.id));
  }, [difficultyFilter, siemFilter]);
  const easy = filteredTasks.filter((task) => task.difficulty === "easy").length;
  const medium = filteredTasks.filter((task) => task.difficulty === "medium").length;
  const hard = filteredTasks.filter((task) => task.difficulty === "hard").length;
  const workbench = filteredTasks.filter((task) => task.featureLabel === "workbench").length;
  const healthCheck = filteredTasks.length - workbench;
  const passCount = filteredTasks.filter((task) => task.result === "pass").length;
  const passRate = filteredTasks.length ? Math.round((passCount / filteredTasks.length) * 100) : 0;
  const siemCount = siemFilter === "All SIEMs" ? SIEMS.length : 1;
  const difficultyOptions: Array<{ id: DifficultyFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "easy", label: "Easy" },
    { id: "medium", label: "Medium" },
    { id: "hard", label: "Hard" },
  ];

  return (
    <div className="h-full overflow-auto px-5 py-4" style={{ background: C.bg }}>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold tracking-tight" style={{ color: C.fg5 }}>Spectrum Benchmark</h1>
          <p className="mt-1 text-[15px]" style={{ color: C.fg0 }}>AI-powered detection engineering evaluation across SIEM platforms.</p>
        </div>
        <div className="flex items-center gap-2 text-[12px] font-mono" style={{ color: C.fg0 }}>
          <ShieldCheck className="size-4" />
          <span>DetectBench</span>
        </div>
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_500px]">
        <div className="min-w-0 space-y-6">
          <section className="rounded-lg border p-6" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.10)" }}>
            <div className="text-[12px] font-mono uppercase tracking-[0.18em]" style={{ color: C.fg1 }}>Overall Benchmark Scores</div>
            <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr_1fr_220px]">
              <StatTile label="Spectrum" value={`${passRate}%`} accent={passRate >= 70 ? C.green : C.orange} />
              <StatTile label="Claude Code" value="72%" accent={C.fg5} />
              <StatTile label="ChatGPT" value="65%" accent={C.fg5} />
              <div className="flex flex-col items-start justify-end">
                <ScoreTrend />
                <div className="mt-1 text-[11px]" style={{ color: C.fg0 }}>3-month trend</div>
              </div>
            </div>
            <div className="mt-5 text-[12px]" style={{ color: C.fg0 }}>
              Across {filteredTasks.length} detection tasks, {siemCount} SIEM {siemCount === 1 ? "platform" : "platforms"}, and {workbench} workbench scenarios.
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border" style={{ background: "rgba(255,255,255,0.02)", borderColor: C.border }}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="flex flex-wrap items-center gap-2">
                <Filter className="size-4" style={{ color: C.fg0 }} />
                <span className="text-[12px]" style={{ color: C.fg0 }}>Filter by difficulty:</span>
                <div className="flex items-center gap-1">
                  {difficultyOptions.map((option) => {
                    const active = difficultyFilter === option.id;
                    return (
                      <button
                        key={option.id}
                        className="h-7 rounded px-3 text-[11px] font-medium transition-colors"
                        style={{ color: active ? C.bg : C.fg1, background: active ? C.fg5 : "rgba(255,255,255,0.06)" }}
                        onClick={() => setDifficultyFilter(option.id)}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px]" style={{ color: C.fg0 }}>Showing {filteredTasks.length} of {TASKS.length} scenarios</span>
                <select
                  className="h-8 min-w-[210px] rounded-md border bg-black px-2 text-[12px] outline-none"
                  style={{ color: C.fg3, borderColor: "rgba(255,255,255,0.12)" }}
                  value={siemFilter}
                  onChange={(event) => setSiemFilter(event.target.value as SiemFilter)}
                >
                  <option>All SIEMs</option>
                  {SIEMS.map((siem) => <option key={siem}>{siem}</option>)}
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <div
                className="grid min-w-[980px] px-4 py-2 text-[10px] font-mono uppercase tracking-wide"
                style={{
                  gridTemplateColumns: "48px 98px minmax(320px,2fr) 108px 132px 84px",
                  columnGap: 12,
                  color: C.fg0,
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div>#</div>
                <div>Ticket</div>
                <div>Detection Scenario</div>
                <div>Difficulty</div>
                <div>SIEM</div>
                <div>Result</div>
              </div>
              <div className="max-h-[calc(100vh-430px)] min-h-[420px] overflow-auto sb">
                {filteredTasks.length === 0 ? (
                  <div className="min-w-[980px] px-4 py-14 text-center text-[13px]" style={{ color: C.fg0 }}>
                    No benchmark scenarios match the selected filters.
                  </div>
                ) : filteredTasks.map((task, index) => (
                  <div
                    key={task.id}
                    className="grid min-w-[980px] items-center px-4 py-2.5 text-[12px]"
                    style={{
                      gridTemplateColumns: "48px 98px minmax(320px,2fr) 108px 132px 84px",
                      columnGap: 12,
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                    }}
                  >
                    <div className="font-mono" style={{ color: C.fg0 }}>{index + 1}</div>
                    <div className="font-mono font-semibold" style={{ color: "#F5CE4E" }}>{task.id}</div>
                    <div className="min-w-0">
                      <div className="truncate" style={{ color: C.fg4 }}>{task.task}</div>
                      <div className="mt-0.5 truncate text-[10px] font-mono xl:hidden" style={{ color: C.fg0 }}>{task.agent} · {task.requestType}</div>
                    </div>
                    <div><Badge style={difficultyStyle[task.difficulty]}>{task.difficulty}</Badge></div>
                    <div className="truncate font-mono" style={{ color: C.fg2 }}>{task.siem}</div>
                    <ResultCell result={task.result} />
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <Panel
            title="Benchmark Suite"
            action={<a className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: "#F5CE4E" }} href="/detectbench"><span>View Dataset</span><ExternalLink className="size-3" /></a>}
          >
            <div className="text-[20px] font-semibold" style={{ color: C.fg5 }}>Spectrum Detection v1.0</div>
            <div className="mt-5 flex items-end gap-6">
              <div><span className="text-[32px] font-semibold" style={{ color: C.fg5 }}>{filteredTasks.length}</span> <span className="text-[13px]" style={{ color: C.fg0 }}>tasks</span></div>
              <div><span className="text-[32px] font-semibold" style={{ color: C.fg5 }}>{siemCount}</span> <span className="text-[13px]" style={{ color: C.fg0 }}>SIEM {siemCount === 1 ? "platform" : "platforms"}</span></div>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

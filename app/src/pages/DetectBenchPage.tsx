import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { C } from "../utils/colors";

type Difficulty = "easy" | "medium" | "hard";
type FeatureLabel = "workbench" | "health check";
type Siem = "Databricks" | "SumoLogic" | "Google SecOps" | "Crowdstrike NG SIEM" | "Elastic" | "Splunk" | "Sentinel";
type SiemFilter = "All SIEMs" | Siem;

interface DetectBenchTask {
  id: string;
  task: string;
  siem: Siem;
  difficulty: Difficulty;
  featureLabel: FeatureLabel;
  requestType: string;
  agent: string;
  dataset: string;
}

const SIEMS: Siem[] = ["Databricks", "SumoLogic", "Google SecOps", "Crowdstrike NG SIEM", "Elastic", "Splunk", "Sentinel"];

const TASKS: DetectBenchTask[] = [
  { id: "DB-001", task: "Write detections for Artifactory access logs", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-author-agent", dataset: "detection_author_agent/spectrum" },
  { id: "DB-002", task: "Classify first-time AWS KMS Decrypt activity with missing baselines", siem: "Databricks", difficulty: "hard", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/aws" },
  { id: "DB-003", task: "Decide whether O365 legacy auth can be detected from provided fields", siem: "Sentinel", difficulty: "easy", featureLabel: "health check", requestType: "customer request", agent: "detection-review-agent", dataset: "detection_review_agent/o365" },
  { id: "DB-004", task: "Write Google SecOps rule logic for CloudTrail recon aggregation", siem: "Google SecOps", difficulty: "medium", featureLabel: "workbench", requestType: "threat model", agent: "detection-author-agent", dataset: "detection_author_agent/google_secops" },
  { id: "DB-005", task: "Explain why Fortinet VPN conditional auth cannot be implemented strictly", siem: "SumoLogic", difficulty: "hard", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-review-agent", dataset: "detection_review_agent/fortinet" },
  { id: "DB-006", task: "Generate Elastic EQL for a degraded dropper sequence", siem: "Elastic", difficulty: "hard", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/elastic" },
  { id: "DB-007", task: "Validate Sysmon Event ID 8 structural detection coverage", siem: "Crowdstrike NG SIEM", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-validator-agent", dataset: "detection_validator_agent/sysmon" },
  { id: "DB-008", task: "Write detection guidance for Mimecast URL clicked telemetry", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-author-agent", dataset: "detection_author_agent/mimecast" },
  { id: "DB-009", task: "Classify new external IP login as implementable or baseline-only", siem: "Sentinel", difficulty: "medium", featureLabel: "workbench", requestType: "research review", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/identity" },
  { id: "DB-010", task: "Score detection output for S3 GetBucketAcl by IAMUser", siem: "Databricks", difficulty: "easy", featureLabel: "health check", requestType: "judge calibration", agent: "detection-judge-agent", dataset: "detection_judge_agent/aws" },
  { id: "DB-011", task: "Build Defender registry disable detection from Windows logs", siem: "Crowdstrike NG SIEM", difficulty: "medium", featureLabel: "workbench", requestType: "threat model", agent: "detection-author-agent", dataset: "detection_author_agent/defender" },
  { id: "DB-012", task: "Determine whether first-time process hash is practically implementable", siem: "Elastic", difficulty: "hard", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/endpoint" },
  { id: "DB-013", task: "Draft LastPass outside business hours detection and caveats", siem: "SumoLogic", difficulty: "medium", featureLabel: "workbench", requestType: "customer escalation", agent: "detection-author-agent", dataset: "detection_author_agent/lastpass" },
  { id: "DB-014", task: "Health check parser output for DNS beaconing threshold scenario", siem: "Google SecOps", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-parser-agent", dataset: "detection_parser_agent/dns" },
  { id: "DB-015", task: "Translate net.exe Domain Admins behavior into SIEM-agnostic logic", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-modeler-agent", dataset: "detection_modeler_agent" },
  { id: "DB-016", task: "Assess DB audit absent evidence and return logs_missing", siem: "Databricks", difficulty: "easy", featureLabel: "health check", requestType: "customer request", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/database" },
  { id: "DB-017", task: "Write PowerShell EncodedCommand detection with false positive notes", siem: "Sentinel", difficulty: "easy", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/powershell" },
  { id: "DB-018", task: "Model cross-account AssumeRole degraded telemetry requirements", siem: "SumoLogic", difficulty: "hard", featureLabel: "workbench", requestType: "threat model", agent: "detection-modeler-agent", dataset: "detection_modeler_agent/aws" },
  { id: "DB-019", task: "Validate Fortinet VPN auth-failure detection output", siem: "Elastic", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-validator-agent", dataset: "detection_validator_agent/fortinet" },
  { id: "DB-020", task: "Author DGA standalone heuristic with degraded threshold handling", siem: "Google SecOps", difficulty: "hard", featureLabel: "workbench", requestType: "research review", agent: "detection-author-agent", dataset: "detection_author_agent/dns" },
  { id: "DB-021", task: "Judge whether first-login from new country requires unavailable history", siem: "Sentinel", difficulty: "medium", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-judge-agent", dataset: "detection_judge_agent/identity" },
  { id: "DB-022", task: "CreateRemoteThread clean detection with Sysmon source assumptions", siem: "Crowdstrike NG SIEM", difficulty: "medium", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/sysmon" },
  { id: "DB-023", task: "Check CloudTrail AccessDenied spray scoring consistency", siem: "Databricks", difficulty: "easy", featureLabel: "health check", requestType: "judge calibration", agent: "detection-judge-agent", dataset: "detection_judge_agent/aws" },
  { id: "DB-024", task: "Write SIEM-agnostic acceptance criteria for a detection bug", siem: "Splunk", difficulty: "medium", featureLabel: "workbench", requestType: "Jira bug", agent: "research-review-agent", dataset: "research_review_agent" },
  { id: "DB-025", task: "Map SEP2 Google SecOps dataset fields to benchmark expectations", siem: "Google SecOps", difficulty: "hard", featureLabel: "workbench", requestType: "SIEM migration", agent: "detection-modeler-agent", dataset: "detection_modeler_agent/google_secops" },
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
    <div className="min-w-[132px] rounded-lg border px-3 py-2.5" style={{ background: "rgba(255,255,255,0.035)", borderColor: "rgba(255,255,255,0.09)" }}>
      <div className="text-[24px] font-semibold leading-none" style={{ color: accent }}>{value}</div>
      <div className="mt-1 text-[10px] font-mono uppercase" style={{ color: C.fg0 }}>{label}</div>
    </div>
  );
}

export function DetectBenchPage() {
  const [siemFilter, setSiemFilter] = useState<SiemFilter>("All SIEMs");
  const sortedTasks = useMemo(() => {
    return TASKS
      .filter((task) => siemFilter === "All SIEMs" || task.siem === siemFilter)
      .sort((a, b) => SIEMS.indexOf(a.siem) - SIEMS.indexOf(b.siem) || a.id.localeCompare(b.id));
  }, [siemFilter]);
  const easy = sortedTasks.filter((task) => task.difficulty === "easy").length;
  const medium = sortedTasks.filter((task) => task.difficulty === "medium").length;
  const hard = sortedTasks.filter((task) => task.difficulty === "hard").length;
  const workbench = sortedTasks.filter((task) => task.featureLabel === "workbench").length;
  const healthCheck = sortedTasks.length - workbench;

  return (
    <div className="h-full overflow-auto px-5 py-4" style={{ background: C.bg }}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md border" style={{ color: C.cyan, background: "rgba(79,202,227,0.10)", borderColor: "rgba(79,202,227,0.28)" }}>
              <ShieldCheck className="size-4" />
            </div>
            <h1 className="text-[18px] font-semibold" style={{ color: C.fg4 }}>DetectBench</h1>
          </div>
          <p className="mt-1 text-[12px]" style={{ color: C.fg0 }}>Agent benchmark tasks and regression scenarios.</p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <StatTile label="tasks" value={sortedTasks.length} accent={C.fg5} />
          <StatTile label="workbench" value={workbench} accent={C.accent} />
          <StatTile label="health checks" value={healthCheck} accent={C.cyan} />
          <StatTile label="easy / med / hard" value={`${easy}/${medium}/${hard}`} accent={C.orange} />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2" style={{ background: "rgba(255,255,255,0.025)", borderColor: C.border }}>
        <div>
          <div className="text-[11px] font-medium" style={{ color: C.fg3 }}>SIEM</div>
          <div className="mt-0.5 text-[10px] font-mono" style={{ color: C.fg0 }}>Table is sorted by SIEM, then task ID.</div>
        </div>
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

      <div className="overflow-hidden rounded-lg border" style={{ background: "rgba(255,255,255,0.02)", borderColor: C.border }}>
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[1360px] px-3 py-2 text-[10px] font-mono uppercase tracking-wide"
            style={{
              gridTemplateColumns: "74px minmax(340px,2.4fr) 154px 94px 118px 150px minmax(180px,1fr) minmax(220px,1.2fr)",
              columnGap: 12,
              color: C.fg0,
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div>ID</div>
            <div>Test</div>
            <div>SIEM</div>
            <div>Level</div>
            <div>Feature</div>
            <div>Request Type</div>
            <div>Agent</div>
            <div>Dataset</div>
          </div>
          <div className="max-h-[calc(100vh-190px)] overflow-auto sb">
            {sortedTasks.map((task) => (
              <div
                key={task.id}
                className="grid min-w-[1360px] items-center px-3 py-2.5 text-[11px]"
                style={{
                  gridTemplateColumns: "74px minmax(340px,2.4fr) 154px 94px 118px 150px minmax(180px,1fr) minmax(220px,1.2fr)",
                  columnGap: 12,
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                }}
              >
                <div className="font-mono" style={{ color: C.fg0 }}>{task.id}</div>
                <div className="min-w-0">
                  <div className="truncate" style={{ color: C.fg3 }}>{task.task}</div>
                </div>
                <div className="truncate font-mono" style={{ color: C.fg2 }}>{task.siem}</div>
                <div><Badge style={difficultyStyle[task.difficulty]}>{task.difficulty}</Badge></div>
                <div><Badge style={featureStyle[task.featureLabel]}>{task.featureLabel}</Badge></div>
                <div className="truncate font-mono" style={{ color: C.fg2 }}>{task.requestType}</div>
                <div className="truncate font-mono" style={{ color: C.fg1 }}>{task.agent}</div>
                <div className="truncate font-mono" style={{ color: C.fg0 }}>{task.dataset}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

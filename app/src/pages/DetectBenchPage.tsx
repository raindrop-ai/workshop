import { ShieldCheck } from "lucide-react";
import { C } from "../utils/colors";

type Difficulty = "easy" | "medium" | "hard";
type FeatureLabel = "workbench" | "health check";

interface DetectBenchTask {
  id: string;
  task: string;
  difficulty: Difficulty;
  featureLabel: FeatureLabel;
  requestType: string;
  agent: string;
  dataset: string;
}

const TASKS: DetectBenchTask[] = [
  { id: "DB-001", task: "Write detections for Artifactory access logs", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-author-agent", dataset: "detection_author_agent/spectrum" },
  { id: "DB-002", task: "Classify first-time AWS KMS Decrypt activity with missing baselines", difficulty: "hard", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/aws" },
  { id: "DB-003", task: "Decide whether O365 legacy auth can be detected from provided fields", difficulty: "easy", featureLabel: "health check", requestType: "customer request", agent: "detection-review-agent", dataset: "detection_review_agent/o365" },
  { id: "DB-004", task: "Write Google SecOps rule logic for CloudTrail recon aggregation", difficulty: "medium", featureLabel: "workbench", requestType: "threat model", agent: "detection-author-agent", dataset: "detection_author_agent/google_secops" },
  { id: "DB-005", task: "Explain why Fortinet VPN conditional auth cannot be implemented strictly", difficulty: "hard", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-review-agent", dataset: "detection_review_agent/fortinet" },
  { id: "DB-006", task: "Generate Elastic EQL for a degraded dropper sequence", difficulty: "hard", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/elastic" },
  { id: "DB-007", task: "Validate Sysmon Event ID 8 structural detection coverage", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-validator-agent", dataset: "detection_validator_agent/sysmon" },
  { id: "DB-008", task: "Write detection guidance for Mimecast URL clicked telemetry", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-author-agent", dataset: "detection_author_agent/mimecast" },
  { id: "DB-009", task: "Classify new external IP login as implementable or baseline-only", difficulty: "medium", featureLabel: "workbench", requestType: "research review", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/identity" },
  { id: "DB-010", task: "Score detection output for S3 GetBucketAcl by IAMUser", difficulty: "easy", featureLabel: "health check", requestType: "judge calibration", agent: "detection-judge-agent", dataset: "detection_judge_agent/aws" },
  { id: "DB-011", task: "Build Defender registry disable detection from Windows logs", difficulty: "medium", featureLabel: "workbench", requestType: "threat model", agent: "detection-author-agent", dataset: "detection_author_agent/defender" },
  { id: "DB-012", task: "Determine whether first-time process hash is practically implementable", difficulty: "hard", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/endpoint" },
  { id: "DB-013", task: "Draft LastPass outside business hours detection and caveats", difficulty: "medium", featureLabel: "workbench", requestType: "customer escalation", agent: "detection-author-agent", dataset: "detection_author_agent/lastpass" },
  { id: "DB-014", task: "Health check parser output for DNS beaconing threshold scenario", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-parser-agent", dataset: "detection_parser_agent/dns" },
  { id: "DB-015", task: "Translate net.exe Domain Admins behavior into SIEM-agnostic logic", difficulty: "medium", featureLabel: "workbench", requestType: "tactical ticket", agent: "detection-modeler-agent", dataset: "detection_modeler_agent" },
  { id: "DB-016", task: "Assess DB audit absent evidence and return logs_missing", difficulty: "easy", featureLabel: "health check", requestType: "customer request", agent: "detection-classifier-agent", dataset: "detection_classifier_agent/database" },
  { id: "DB-017", task: "Write PowerShell EncodedCommand detection with false positive notes", difficulty: "easy", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/powershell" },
  { id: "DB-018", task: "Model cross-account AssumeRole degraded telemetry requirements", difficulty: "hard", featureLabel: "workbench", requestType: "threat model", agent: "detection-modeler-agent", dataset: "detection_modeler_agent/aws" },
  { id: "DB-019", task: "Validate Fortinet VPN auth-failure detection output", difficulty: "easy", featureLabel: "health check", requestType: "regression check", agent: "detection-validator-agent", dataset: "detection_validator_agent/fortinet" },
  { id: "DB-020", task: "Author DGA standalone heuristic with degraded threshold handling", difficulty: "hard", featureLabel: "workbench", requestType: "research review", agent: "detection-author-agent", dataset: "detection_author_agent/dns" },
  { id: "DB-021", task: "Judge whether first-login from new country requires unavailable history", difficulty: "medium", featureLabel: "workbench", requestType: "SME annotation", agent: "detection-judge-agent", dataset: "detection_judge_agent/identity" },
  { id: "DB-022", task: "CreateRemoteThread clean detection with Sysmon source assumptions", difficulty: "medium", featureLabel: "workbench", requestType: "red team report", agent: "detection-author-agent", dataset: "detection_author_agent/sysmon" },
  { id: "DB-023", task: "Check CloudTrail AccessDenied spray scoring consistency", difficulty: "easy", featureLabel: "health check", requestType: "judge calibration", agent: "detection-judge-agent", dataset: "detection_judge_agent/aws" },
  { id: "DB-024", task: "Write SIEM-agnostic acceptance criteria for a detection bug", difficulty: "medium", featureLabel: "workbench", requestType: "Jira bug", agent: "research-review-agent", dataset: "research_review_agent" },
  { id: "DB-025", task: "Map SEP2 Google SecOps dataset fields to benchmark expectations", difficulty: "hard", featureLabel: "workbench", requestType: "SIEM migration", agent: "detection-modeler-agent", dataset: "detection_modeler_agent/google_secops" },
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

export function DetectBenchPage() {
  const easy = TASKS.filter((task) => task.difficulty === "easy").length;
  const medium = TASKS.filter((task) => task.difficulty === "medium").length;
  const hard = TASKS.filter((task) => task.difficulty === "hard").length;
  const workbench = TASKS.filter((task) => task.featureLabel === "workbench").length;
  const healthCheck = TASKS.length - workbench;

  return (
    <div className="h-full overflow-auto px-5 py-4" style={{ background: C.bg }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md border" style={{ color: C.cyan, background: "rgba(79,202,227,0.10)", borderColor: "rgba(79,202,227,0.28)" }}>
              <ShieldCheck className="size-4" />
            </div>
            <h1 className="text-[18px] font-semibold" style={{ color: C.fg4 }}>DetectBench</h1>
          </div>
          <p className="mt-1 text-[12px]" style={{ color: C.fg0 }}>Agent benchmark tasks and regression scenarios.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono" style={{ color: C.fg0 }}>
          <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-1">{TASKS.length} tasks</span>
          <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-1">{workbench} workbench</span>
          <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-1">{healthCheck} health checks</span>
          <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-1">{easy}/{medium}/{hard} easy/medium/hard</span>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border" style={{ background: "rgba(255,255,255,0.02)", borderColor: C.border }}>
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[1220px] px-3 py-2 text-[10px] font-mono uppercase tracking-wide"
            style={{
              gridTemplateColumns: "74px minmax(340px,2.5fr) 94px 118px 150px minmax(180px,1fr) minmax(220px,1.2fr)",
              columnGap: 12,
              color: C.fg0,
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div>ID</div>
            <div>Test</div>
            <div>Level</div>
            <div>Feature</div>
            <div>Request Type</div>
            <div>Agent</div>
            <div>Dataset</div>
          </div>
          <div className="max-h-[calc(100vh-190px)] overflow-auto sb">
            {TASKS.map((task) => (
              <div
                key={task.id}
                className="grid min-w-[1220px] items-center px-3 py-2.5 text-[11px]"
                style={{
                  gridTemplateColumns: "74px minmax(340px,2.5fr) 94px 118px 150px minmax(180px,1fr) minmax(220px,1.2fr)",
                  columnGap: 12,
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                }}
              >
                <div className="font-mono" style={{ color: C.fg0 }}>{task.id}</div>
                <div className="min-w-0">
                  <div className="truncate" style={{ color: C.fg3 }}>{task.task}</div>
                </div>
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

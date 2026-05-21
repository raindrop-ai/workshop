import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  listAssignedJiraIssues,
  listEnvironmentProfiles,
  listLangfuseDatasets,
  type EnvironmentProfile,
  type JiraIssueSummary,
  type JiraTeamUser,
  type LangfuseDatasetSummary,
} from "../api/research";
import { C } from "../utils/colors";

const STORAGE_KEY = "workshop:case-context:v1";
const JIRA_BASE_URL = "https://synthropic.atlassian.net/browse";

interface CaseContext {
  ticketKey: string;
  jiraUserId: string;
  environment: string;
  datasetName: string;
}

const DEFAULT_CONTEXT: CaseContext = {
  ticketKey: "CORE-1411",
  jiraUserId: "dylan",
  environment: "Spectrum",
  datasetName: "",
};

function loadContext(): CaseContext {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<CaseContext> | null;
    return { ...DEFAULT_CONTEXT, ...(parsed || {}) };
  } catch {
    return DEFAULT_CONTEXT;
  }
}

function JiraLink({ issueKey }: { issueKey: string }) {
  const key = issueKey.trim();
  if (!key) return null;
  return (
    <a
      className="inline-flex items-center rounded px-1 py-0.5 transition-colors hover:bg-white/10"
      href={`${JIRA_BASE_URL}/${encodeURIComponent(key)}`}
      rel="noreferrer"
      target="_blank"
      title={`Open ${key} in Jira`}
    >
      <ExternalLink className="size-3" style={{ color: C.fg1 }} />
    </a>
  );
}

function SiemMark({ siem }: { siem?: string }) {
  const normalized = (siem || "").toLowerCase();
  const config = normalized.includes("secops")
    ? { label: "G", background: "rgba(66,133,244,0.18)", border: "rgba(66,133,244,0.45)", color: "#8ab4f8", title: "Google SecOps" }
    : normalized.includes("splunk")
      ? { label: "S", background: "rgba(92,214,92,0.15)", border: "rgba(92,214,92,0.38)", color: "#75db75", title: "Splunk" }
      : normalized.includes("agnostic")
        ? { label: "A", background: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.18)", color: C.fg2, title: "SIEM agnostic" }
        : { label: "E", background: "rgba(0,191,179,0.15)", border: "rgba(0,191,179,0.38)", color: "#55d7cf", title: "Elastic" };

  return (
    <span
      className="pointer-events-none absolute left-2 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-[4px] text-[9px] font-semibold"
      style={{ background: config.background, border: `1px solid ${config.border}`, color: config.color }}
      title={config.title}
    >
      {config.label}
    </span>
  );
}

interface CaseContextPanelProps {
  selectedRunId: string | null;
  floating?: boolean;
}

export function CaseContextPanel({ selectedRunId: _selectedRunId, floating = false }: CaseContextPanelProps) {
  const [context, setContext] = useState<CaseContext>(loadContext);
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [datasets, setDatasets] = useState<LangfuseDatasetSummary[]>([]);
  const [jiraUsers, setJiraUsers] = useState<JiraTeamUser[]>([]);
  const [jiraIssues, setJiraIssues] = useState<JiraIssueSummary[]>([]);
  const [researchError, setResearchError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
    } catch {
      /* ignore */
    }
  }, [context]);

  useEffect(() => {
    listEnvironmentProfiles()
      .then((nextProfiles) => {
        setProfiles(nextProfiles);
        if (!nextProfiles.some((profile) => profile.label === context.environment) && nextProfiles[0]) {
          update("environment", nextProfiles[0].label);
        }
      })
      .catch((error) => setResearchError(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listAssignedJiraIssues({ userId: context.jiraUserId })
      .then((result) => {
        setJiraUsers(result.users);
        setJiraIssues(result.issues);
        setContext((prev) => {
          const currentIsValid = prev.ticketKey && result.issues.some((issue) => issue.key === prev.ticketKey);
          const nextTicket = currentIsValid ? prev.ticketKey : result.issues[0]?.key ?? "";
          const nextUserId = result.users.some((user) => user.id === prev.jiraUserId) ? prev.jiraUserId : result.user.id || prev.jiraUserId;
          return nextTicket === prev.ticketKey && nextUserId === prev.jiraUserId ? prev : { ...prev, jiraUserId: nextUserId, ticketKey: nextTicket };
        });
      })
      .catch((error) => setResearchError(error instanceof Error ? error.message : String(error)));
  }, [context.jiraUserId]);

  const update = <K extends keyof CaseContext>(key: K, value: CaseContext[K]) => {
    setContext((prev) => ({ ...prev, [key]: value }));
  };

  const selectedProfile = profiles.find((profile) => profile.label === context.environment) ?? profiles[0] ?? null;

  useEffect(() => {
    if (!selectedProfile) return;
    setResearchError(null);
    listLangfuseDatasets({ environment: selectedProfile.id, lfEnv: "prod" })
      .then((result) => {
        setDatasets(result.datasets);
        const preferred =
          selectedProfile.datasetDefaults.find((name) => result.datasets.some((dataset) => dataset.name === name)) ??
          result.datasets[0]?.name ??
          "";
        setContext((prev) => {
          const currentIsValid = prev.datasetName && result.datasets.some((dataset) => dataset.name === prev.datasetName);
          return currentIsValid ? prev : { ...prev, datasetName: preferred };
        });
      })
      .catch((error) => setResearchError(error instanceof Error ? error.message : String(error)));
  }, [selectedProfile]);

  const panelStyle = floating
    ? {
        background: "rgba(7,9,12,0.90)",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.38)",
      }
    : { borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(7,9,12,0.94)" };

  return (
    <div
      className={[
        "flex flex-shrink-0 flex-col gap-1.5",
        floating
          ? "w-[520px] max-w-[calc(100vw-24px)] rounded-lg px-2.5 py-2 backdrop-blur"
          : "px-3 py-2",
      ].join(" ")}
      style={panelStyle}
    >
      <div className="grid grid-cols-[118px_minmax(0,1fr)_24px] items-end gap-1.5">
        <label className="min-w-0">
          <span className="mb-1 block text-[10px] font-mono uppercase tracking-wide" style={{ color: C.fg0 }}>User</span>
          <select
            className="h-7 w-full rounded px-2 text-[11px] font-mono outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: C.fg3 }}
            value={context.jiraUserId}
            onChange={(event) => update("jiraUserId", event.target.value)}
            title="Research team member"
          >
            {(jiraUsers.length ? jiraUsers : [{ id: context.jiraUserId, label: "Dylan", accountId: "", displayName: "Dylan" }]).map((user) => (
              <option key={user.id} value={user.id}>{user.label}</option>
            ))}
          </select>
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-[10px] font-mono uppercase tracking-wide" style={{ color: C.fg0 }}>Jira Ticket</span>
          <select
            className="h-7 w-full rounded px-2 text-[11px] font-mono outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: C.fg3 }}
            value={context.ticketKey}
            onChange={(event) => update("ticketKey", event.target.value)}
            title="Assigned Jira ticket"
          >
            {jiraIssues.length === 0 && <option value="">No assigned CORE tickets</option>}
            {jiraIssues.map((issue) => (
              <option key={issue.key} value={issue.key}>
                {issue.key} - {issue.summary}
              </option>
            ))}
          </select>
        </label>

        <div className="flex h-7 items-center justify-center">
          <JiraLink issueKey={context.ticketKey} />
        </div>
      </div>

      <div className="grid grid-cols-[168px_minmax(0,1fr)] gap-1.5">
        <label className="min-w-0">
          <span className="mb-1 block text-[10px] font-mono uppercase tracking-wide" style={{ color: C.fg0 }}>Environment</span>
          <div className="relative">
            <SiemMark siem={selectedProfile?.siem} />
            <select
              className="h-7 w-full rounded py-0 pl-8 pr-2 text-[11px] font-mono outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: C.fg3 }}
              value={context.environment}
              onChange={(event) => update("environment", event.target.value)}
              title={selectedProfile?.siem ? `Environment (${selectedProfile.siem})` : "Environment"}
            >
              {(profiles.length ? profiles : [{ id: "default", label: context.environment } as EnvironmentProfile]).map((env) => <option key={env.id} value={env.label}>{env.label}</option>)}
            </select>
          </div>
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-[10px] font-mono uppercase tracking-wide" style={{ color: C.fg0 }}>Dataset</span>
          <select
            className="h-7 w-full rounded px-2 text-[11px] font-mono outline-none"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: C.fg3 }}
            value={context.datasetName}
            onChange={(event) => update("datasetName", event.target.value)}
            title="Langfuse dataset"
          >
            {datasets.length === 0 && <option value="">No dataset found</option>}
            {datasets.map((dataset) => (
              <option key={dataset.id || dataset.name} value={dataset.name}>
                {dataset.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {researchError && (
        <div className="truncate text-[10px] font-mono" style={{ color: C.red }}>
          {researchError}
        </div>
      )}
    </div>
  );
}

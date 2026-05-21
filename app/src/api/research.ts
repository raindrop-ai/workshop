import { apiJson } from "./request";

export interface EnvironmentProfile {
  id: string;
  label: string;
  customer: string;
  siem: string;
  tenantId: string;
  tenantIdSource: string;
  hasCredentials: boolean;
  missing: string[];
  datasetDefaults: string[];
}

export interface LangfuseDatasetSummary {
  id: string;
  name: string;
  itemCount: number;
  runs: string[];
  latestRun: string | null;
  updatedAt: string | null;
  relevance?: number;
}

export interface LangfuseScoreSummary {
  scoreName: string;
  total: number;
  scored: number;
  passing: number;
  failing: number;
  review: number;
  score: number;
}

export interface LangfuseDatasetStats {
  dataset: LangfuseDatasetSummary;
  selectedRun: string | null;
  runs: string[];
  scoreSummary: LangfuseScoreSummary | null;
  langfuseUrl: string;
}

export interface JiraUserSummary {
  id: string;
  displayName: string;
}

export interface JiraTeamUser {
  id: string;
  label: string;
  accountId: string;
  displayName: string;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  description: string;
  assigneeName: string;
  status: string;
  issueType: string;
  priority: string;
  updated: string;
  url: string;
}

export async function listEnvironmentProfiles(): Promise<EnvironmentProfile[]> {
  const data = await apiJson<{ profiles: EnvironmentProfile[] }>("/research-api/environments");
  return data.profiles;
}

export async function listAssignedJiraIssues(input: { userId?: string } = {}): Promise<{ users: JiraTeamUser[]; user: JiraUserSummary; issues: JiraIssueSummary[] }> {
  const params = new URLSearchParams();
  if (input.userId) params.set("userId", input.userId);
  const qs = params.toString();
  return apiJson<{ users: JiraTeamUser[]; user: JiraUserSummary; issues: JiraIssueSummary[] }>(`/research-api/jira/assigned${qs ? `?${qs}` : ""}`);
}

export async function listLangfuseDatasets(input: { agent?: string; environment?: string; lfEnv?: "exp" | "prod" }) {
  const params = new URLSearchParams();
  if (input.agent) params.set("agent", input.agent);
  if (input.environment) params.set("environment", input.environment);
  if (input.lfEnv) params.set("lfEnv", input.lfEnv);
  return apiJson<{ datasets: LangfuseDatasetSummary[]; total: number; langfuseUrl: string }>(`/research-api/langfuse/datasets?${params}`);
}

export async function getLangfuseDatasetStats(input: {
  name: string;
  runName?: string;
  scoreName?: string;
  lfEnv?: "exp" | "prod";
}): Promise<LangfuseDatasetStats> {
  const params = new URLSearchParams({ name: input.name });
  if (input.runName) params.set("runName", input.runName);
  if (input.scoreName) params.set("scoreName", input.scoreName);
  if (input.lfEnv) params.set("lfEnv", input.lfEnv);
  return apiJson<LangfuseDatasetStats>(`/research-api/langfuse/dataset-stats?${params}`);
}

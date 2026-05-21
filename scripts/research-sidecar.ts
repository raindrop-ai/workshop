import { readFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.RESEARCH_SIDECAR_PORT ?? "5902");
const AGENT_ENV_PATH =
  process.env.SPECTRUM_AGENT_ENV_PATH ??
  "/Users/dylan/Documents/synthropic-agent-ui/.worktrees/feature-detection-author-deep-agent/agent/.env";
const LANGFUSE_PROJECT_ID = process.env.LANGFUSE_PROJECT_ID ?? "cmnrz34z7050iad07q94dn9ca";
const LANGFUSE_ONPREM_PROJECT_ID = process.env.LANGFUSE_ONPREM_PROJECT_ID ?? "cmdyvso40000bvu07l4ffellc";
const ONPREM_EXPERIMENT_DATASET = "detection_author_agent_elastic_proficio";

type EnvMap = Record<string, string>;

const RESEARCH_TEAM = [
  { id: "anthony", label: "Anthony", query: "Anthony" },
  { id: "rich", label: "Rich", query: "Rich" },
  { id: "dylan", label: "Dylan", query: "Dylan" },
];

const scoreCache = new Map<string, { expiresAt: number; scores: any[] }>();

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    const next = await Promise.all(batch.map((item, batchIndex) => worker(item, index + batchIndex)));
    results.push(...next);
  }
  return results;
}

function parseDotEnv(filePath: string): EnvMap {
  const env: EnvMap = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const env = parseDotEnv(AGENT_ENV_PATH);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function hasAll(keys: string[]): boolean {
  return keys.every((key) => Boolean(env[key]));
}

function profile(id: string, label: string, customer: string, siem: string, tenantIdEnv: string, secretChecks: string[], datasetDefaults: string[]) {
  return {
    id,
    label,
    customer,
    siem,
    tenantId: env[tenantIdEnv] || env.JWT_TENANT_CLAIM || "",
    tenantIdSource: env[tenantIdEnv] ? tenantIdEnv : env.JWT_TENANT_CLAIM ? "JWT_TENANT_CLAIM" : "",
    hasCredentials: hasAll(secretChecks),
    missing: secretChecks.filter((key) => !env[key]),
    datasetDefaults,
  };
}

function environmentProfiles() {
  return [
    profile("spectrum", "Spectrum", "Spectrum", "Agnostic", "SPECTRUM_TENANT_ID", [], ["detection_modeler_agent", "intent_detection_agent/main", "detection_rule_agent"]),
    profile("spectrum-lab", "Spectrum Lab", "Spectrum", "Elastic", "SPECTRUM_LAB_TENANT_ID", ["ELASTICSEARCH_ENDPOINT", "ELASTICSEARCH_API_KEY"], ["detection_author_agent/elastic/spectrum", "detection_modeler_agent"]),
    profile("proficio-elastic", "Proficio Elastic", "Proficio", "Elastic", "PROFICIO_TENANT_ID", ["PROFICIO_ELASTICSEARCH_ENDPOINT", "PROFICIO_ELASTICSEARCH_API_KEY"], ["detection_author_agent/elastic/proficio", "detection_deepagent/elastic/proficio/test_scenarios_v1", "detection_author_agent_elastic_proficio"]),
    profile("sep2-google-secops", "Sep2 Google SecOps", "Sep2", "Google SecOps", "SEP2_TENANT_ID", ["GOOGLE_SECOPS_REGION", "GOOGLE_SECOPS_PROJECT_ID", "GOOGLE_SECOPS_INSTANCE_ID", "GOOGLE_SECOPS_SERVICE_ACCOUNT_JSON"], ["detection_author_agent/secops/sep2", "detection_author_agent_secops_sep2", "dynamic_validation_agent"]),
    profile("splunk-lab", "Splunk Lab", "Spectrum", "Splunk", "SPLUNK_LAB_TENANT_ID", ["SPLUNK_LAB_ES_ENDPOINT", "SPLUNK_LAB_ES_TOKEN"], ["detection_author_agent/splunk/spectrum", "detection_modeler_agent"]),
  ];
}

function langfuseCreds(kind: string) {
  const onprem = kind === "onprem";
  const prod = kind === "prod" || kind === "cloud-prod";
  return {
    host: (
      onprem
        ? env.PROD_LANGFUSE_HOST || env.LANGFUSE_PROD_HOST
        : prod
        ? env.LANGFUSE_CLOUD_PROD_BASE_URL || env.LANGFUSE_CLOUD_PROD_HOST || env.PROD_LANGFUSE_HOST || env.LANGFUSE_PROD_HOST
        : env.LANGFUSE_CLOUD_BASE_URL || env.LANGFUSE_HOST
    ) || env.LANGFUSE_HOST || "",
    publicKey: (
      onprem
        ? env.PROD_LANGFUSE_PUBLIC_KEY || env.LANGFUSE_PROD_PUBLIC_KEY
        : prod
        ? env.LANGFUSE_CLOUD_PROD_PUBLIC_KEY || env.PROD_LANGFUSE_PUBLIC_KEY || env.LANGFUSE_PROD_PUBLIC_KEY
        : env.LANGFUSE_CLOUD_PUBLIC_KEY || env.LANGFUSE_PUBLIC_KEY
    ) || env.LANGFUSE_PUBLIC_KEY || "",
    secretKey: (
      onprem
        ? env.PROD_LANGFUSE_SECRET_KEY || env.LANGFUSE_PROD_SECRET_KEY
        : prod
        ? env.LANGFUSE_CLOUD_PROD_SECRET_KEY || env.PROD_LANGFUSE_SECRET_KEY || env.LANGFUSE_PROD_SECRET_KEY
        : env.LANGFUSE_CLOUD_SECRET_KEY || env.LANGFUSE_SECRET_KEY
    ) || env.LANGFUSE_SECRET_KEY || "",
  };
}

function jiraCreds() {
  return {
    baseUrl: env.JIRA_URL || "",
    username: env.JIRA_USERNAME || "",
    token: env.JIRA_TOKEN || "",
  };
}

async function researchTeamUsers() {
  const users = [];
  for (const member of RESEARCH_TEAM) {
    const matches = await jiraGet("user/assignable/search", {
      project: "CORE",
      query: member.query,
      maxResults: "10",
    });
    const user = (matches ?? [])[0];
    if (user?.accountId) {
      users.push({
        id: member.id,
        label: member.label,
        accountId: user.accountId,
        displayName: user.displayName ?? member.label,
      });
    }
  }
  return users;
}

async function langfuseGet(kind: string, apiPath: string) {
  const creds = langfuseCreds(kind);
  if (!creds.host || !creds.publicKey || !creds.secretKey) throw new Error("Missing Langfuse credentials");
  const auth = Buffer.from(`${creds.publicKey}:${creds.secretKey}`).toString("base64");
  const url = `${creds.host.replace(/\/+$/, "")}/api/public/${apiPath.replace(/^\/+/, "")}`;
  const response = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
  if (!response.ok) throw new Error(`Langfuse API ${response.status}`);
  return response.json();
}

async function jiraGet(apiPath: string, params?: Record<string, string>) {
  const creds = jiraCreds();
  if (!creds.baseUrl || !creds.username || !creds.token) throw new Error("Missing Jira credentials");
  const auth = Buffer.from(`${creds.username}:${creds.token}`).toString("base64");
  const url = new URL(`${creds.baseUrl.replace(/\/+$/, "")}/rest/api/3/${apiPath.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" } });
  if (!response.ok) throw new Error(`Jira API ${response.status}`);
  return response.json();
}

function adfToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";

  const chunks: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") chunks.push(node.text);
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
    if (["paragraph", "heading", "listItem"].includes(node.type)) chunks.push("\n");
  };

  visit(value);
  return chunks
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeJiraIssue(issue: any) {
  const fields = issue.fields ?? {};
  const baseUrl = jiraCreds().baseUrl.replace(/\/+$/, "");
  return {
    key: issue.key,
    summary: fields.summary ?? issue.key,
    description: adfToText(fields.description),
    assigneeName: fields.assignee?.displayName ?? "Unassigned",
    status: fields.status?.name ?? "",
    issueType: fields.issuetype?.name ?? "",
    priority: fields.priority?.name ?? "",
    updated: fields.updated ?? "",
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
  };
}

async function assignedJiraIssues(url: URL) {
  const users = await researchTeamUsers();
  const requestedUserId = url.searchParams.get("userId") || "dylan";
  const selectedUser = users.find((user) => user.id === requestedUserId) ?? users.find((user) => user.id === "dylan") ?? users[0];
  const fields = "summary,assignee,status,issuetype,priority,updated,description";
  const data = await jiraGet("search/jql", {
    jql: selectedUser
      ? `project = CORE AND assignee = "${selectedUser.accountId}" ORDER BY updated DESC`
      : "project = CORE ORDER BY updated DESC",
    maxResults: "50",
    fields,
  });
  return {
    users,
    user: {
      id: selectedUser?.id ?? "",
      displayName: selectedUser?.displayName ?? selectedUser?.label ?? "Research team",
    },
    issues: (data.issues ?? []).map(normalizeJiraIssue),
  };
}

function normalizeDataset(dataset: any) {
  const itemCount = Array.isArray(dataset.items) ? dataset.items.length : dataset.itemCount ?? 0;
  const runs = Array.isArray(dataset.runs) ? [...dataset.runs].sort((a, b) => String(b).localeCompare(String(a))) : [];
  return {
    id: dataset.id,
    name: dataset.name,
    itemCount,
    runs,
    latestRun: runs[0] ?? null,
    updatedAt: dataset.updatedAt ?? dataset.updated_at ?? null,
  };
}

async function fetchAllScores(kind: string, force = false) {
  const cached = scoreCache.get(kind);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.scores;

  const maxPages = kind === "onprem" ? 300 : 10;
  const firstPage = await langfuseGet(kind, "scores?page=1&limit=100");
  const totalPages = Math.min(firstPage.meta?.totalPages ?? 1, maxPages);
  const pages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2);
  const rest = await mapLimit(pages, 12, (page) => langfuseGet(kind, `scores?page=${page}&limit=100`));
  const scores = [
    ...(firstPage.data ?? []),
    ...rest.flatMap((page) => page.data ?? []),
  ];
  const numericScores = scores.filter((score) => score.dataType === "NUMERIC" && Number.isFinite(Number(score.value)));
  scoreCache.set(kind, { expiresAt: Date.now() + 5 * 60 * 1000, scores: numericScores });
  return numericScores;
}

function displayAgentName(datasetName: string) {
  const root = datasetName.split("/")[0] || datasetName;
  return root.replace(/_/g, "-");
}

function summarizeRunScores(run: any, dataset: any, allScores: any[]) {
  const runItems = run.datasetRunItems ?? [];
  const traceIds = new Set(runItems.map((item: any) => item.traceId).filter(Boolean));
  const matched = allScores.filter((score) => traceIds.has(score.traceId) || traceIds.has(score.metadata?.target_trace_id));
  const byName = new Map<string, any[]>();
  for (const score of matched) {
    const bucket = byName.get(score.name) ?? [];
    bucket.push(score);
    byName.set(score.name, bucket);
  }
  const [scoreName, scores] = [...byName.entries()]
    .sort(([, a], [, b]) => new Set(b.map((score) => score.traceId)).size - new Set(a.map((score) => score.traceId)).size)[0] ?? ["", []];

  const latestByTrace = new Map<string, any>();
  for (const score of scores) {
    const previous = latestByTrace.get(score.traceId);
    if (!previous || String(score.updatedAt ?? score.timestamp ?? "") > String(previous.updatedAt ?? previous.timestamp ?? "")) {
      latestByTrace.set(score.traceId, score);
    }
  }

  const values = [...latestByTrace.values()];
  const total = runItems.length || dataset.itemCount || 0;
  const numericValues = values.map((score) => Number(score.value));
  const average = numericValues.length ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length : null;
  const passing = values.filter((score) => Number(score.value) > 0).length;
  const failing = values.filter((score) => Number(score.value) <= 0).length;
  const scored = values.length;

  return {
    scoreName,
    total,
    scored,
    passing,
    failing,
    review: Math.max(0, total - scored),
    score: average === null ? null : Math.round(average <= 1 ? average * 100 : average),
  };
}

async function experimentResults(url: URL) {
  const kind = url.searchParams.get("lfEnv") || "prod";
  const forceScores = url.searchParams.get("refresh") === "1";
  const datasetsResponse = await langfuseGet(kind, "datasets?page=1&limit=100");
  let datasets = (datasetsResponse.data ?? []).map(normalizeDataset);
  if (kind === "onprem") {
    datasets = datasets.filter((dataset: any) => dataset.name === ONPREM_EXPERIMENT_DATASET || dataset.id === "cmlrbd6t10009x907vuqz1owu");
  }
  const allScores = await fetchAllScores(kind, forceScores);
  const results = [];
  const series = [];

  for (const dataset of datasets) {
    if (!dataset.name || dataset.itemCount === 0) continue;
    const detail = normalizeDataset(await langfuseGet(kind, `datasets/${encodeURIComponent(dataset.name)}`));
    const runLimit = kind === "onprem" ? detail.runs.length : 12;
    const runNames = detail.runs.slice(0, runLimit);
    const runs = [];
    const runData = await mapLimit(runNames, kind === "onprem" ? 10 : 4, (runName) =>
      langfuseGet(kind, `datasets/${encodeURIComponent(dataset.name)}/runs/${encodeURIComponent(runName)}`)
        .then((run) => ({ runName, run }))
    );
    for (const { runName, run } of runData) {
      const summary = summarizeRunScores(run, detail, allScores);
      const createdAt = run.createdAt ?? run.updatedAt ?? detail.updatedAt;
      const point = {
        datasetId: detail.id,
        datasetName: detail.name,
        agent: displayAgentName(detail.name),
        runName,
        createdAt,
        score: summary.score,
        scoreName: summary.scoreName,
        total: summary.total,
        scored: summary.scored,
      };
      runs.push(point);
      if (point.score !== null) series.push(point);
    }
    runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const latestRun = runs[0] ?? null;
    results.push({
      id: detail.id,
      name: detail.name,
      agent: displayAgentName(detail.name),
      itemCount: detail.itemCount,
      latestRun,
      runs,
      updatedAt: detail.updatedAt,
    });
  }

  results.sort((a, b) => {
    const scoreA = a.latestRun?.score ?? -1;
    const scoreB = b.latestRun?.score ?? -1;
    return scoreA - scoreB || String(a.name).localeCompare(String(b.name));
  });
  series.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  return {
    datasets: results,
    series,
    source: kind,
    langfuseUrl: `${langfuseCreds(kind).host.replace(/\/+$/, "")}/project/${kind === "onprem" ? LANGFUSE_ONPREM_PROJECT_ID : LANGFUSE_PROJECT_ID}/datasets${kind === "onprem" ? "/cmlrbd6t10009x907vuqz1owu" : "?pageIndex=0&pageSize=50"}`,
    generatedAt: new Date().toISOString(),
  };
}

async function listDatasets(url: URL) {
  const kind = url.searchParams.get("lfEnv") || "exp";
  const agent = (url.searchParams.get("agent") || "").toLowerCase();
  const environmentId = url.searchParams.get("environment") || "";
  const selectedProfile = environmentProfiles().find((item) => item.id === environmentId);
  const data = await langfuseGet(kind, "datasets?page=1&limit=100");
  let datasets = (data.data ?? []).map(normalizeDataset);
  const preferredNames = selectedProfile?.datasetDefaults ?? [];
  if (selectedProfile) {
    if (selectedProfile.siem === "Agnostic") {
      datasets = datasets
        .map((dataset: any) => {
          const name = String(dataset.name).toLowerCase();
          const exactIndex = preferredNames.findIndex((preferredName) => name === preferredName.toLowerCase());
          const isRootDataset = !name.includes("/");
          const relevance = exactIndex >= 0 ? 1000 - exactIndex : isRootDataset ? 1 : 0;
          return { ...dataset, relevance };
        })
        .filter((dataset: any) => dataset.relevance > 0)
        .sort((a: any, b: any) => b.relevance - a.relevance || b.itemCount - a.itemCount);
    } else {
    const preferredTokens = [
      ...selectedProfile.datasetDefaults,
      selectedProfile.customer,
      selectedProfile.siem,
    ]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    datasets = datasets
      .map((dataset: any) => {
        const name = String(dataset.name).toLowerCase();
        const exactIndex = preferredNames.findIndex((preferredName) => name === preferredName.toLowerCase());
        const matches = preferredTokens.filter((token) => name.includes(token)).length;
        const hasCustomer = name.includes(selectedProfile.customer.toLowerCase());
        const hasSiem = name.includes(selectedProfile.siem.toLowerCase().replace(/\s+/g, "_").replace("google_", ""));
        const relevance = exactIndex >= 0 ? 1000 - exactIndex : hasCustomer && hasSiem ? matches : 0;
        return { ...dataset, relevance };
      })
      .filter((dataset: any) => dataset.relevance > 0)
      .sort((a: any, b: any) => b.relevance - a.relevance || b.itemCount - a.itemCount);
    }
  } else if (agent) {
    const tokens = agent.replace(/^execute_/, "").replace(/_task$/, "").split(/[_-]+/).filter(Boolean);
    datasets = datasets
      .map((dataset: any) => {
        const name = String(dataset.name).toLowerCase();
        const matches = tokens.filter((token) => name.includes(token)).length;
        return { ...dataset, relevance: matches };
      })
      .sort((a: any, b: any) => b.relevance - a.relevance || b.itemCount - a.itemCount);
  }
  return {
    datasets,
    total: data.meta?.totalItems ?? datasets.length,
    langfuseUrl: `${langfuseCreds(kind).host.replace(/\/+$/, "")}/project/${LANGFUSE_PROJECT_ID}/datasets?pageIndex=0&pageSize=50`,
  };
}

async function datasetStats(url: URL) {
  const kind = url.searchParams.get("lfEnv") || "exp";
  const name = url.searchParams.get("name");
  const runName = url.searchParams.get("runName") || "";
  const scoreName = url.searchParams.get("scoreName") || "llm_judge_correctness";
  if (!name) return json({ error: "Missing dataset name" }, 400);

  const dataset = normalizeDataset(await langfuseGet(kind, `datasets/${encodeURIComponent(name)}`));
  const selectedRun = runName || dataset.latestRun;
  let run: any = null;
  let scoreSummary = null;

  if (selectedRun) {
    run = await langfuseGet(kind, `datasets/${encodeURIComponent(name)}/runs/${encodeURIComponent(selectedRun)}`);
    const runItems = run.datasetRunItems ?? [];
    const traceIds = new Set(runItems.map((item: any) => item.traceId).filter(Boolean));
    const scoresResponse = await langfuseGet(kind, `scores?page=1&limit=100&name=${encodeURIComponent(scoreName)}`);
    const scores = (scoresResponse.data ?? []).filter((score: any) => traceIds.has(score.traceId));
    const latestByTrace = new Map<string, any>();
    for (const score of scores) {
      const prev = latestByTrace.get(score.traceId);
      if (!prev || String(score.updatedAt ?? "") > String(prev.updatedAt ?? "")) latestByTrace.set(score.traceId, score);
    }
    const values = [...latestByTrace.values()];
    const passing = values.filter((score) => Number(score.value) > 0).length;
    const failing = values.filter((score) => Number(score.value) <= 0).length;
    const total = runItems.length || dataset.itemCount;
    scoreSummary = {
      scoreName,
      total,
      scored: values.length,
      passing,
      failing,
      review: Math.max(0, total - values.length),
      score: total ? Math.round((passing / total) * 100) : 0,
    };
  }

  return json({
    dataset,
    selectedRun,
    runs: dataset.runs,
    scoreSummary,
    langfuseUrl: `${langfuseCreds(kind).host.replace(/\/+$/, "")}/project/${LANGFUSE_PROJECT_ID}/datasets/${encodeURIComponent(dataset.id ?? dataset.name)}`,
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(request) {
    if (request.method === "OPTIONS") return json({});
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, envPath: path.basename(AGENT_ENV_PATH) });
      if (url.pathname === "/research-api/environments") return json({ profiles: environmentProfiles() });
      if (url.pathname === "/research-api/jira/assigned") return json(await assignedJiraIssues(url));
      if (url.pathname === "/research-api/langfuse/datasets") return json(await listDatasets(url));
      if (url.pathname === "/research-api/langfuse/dataset-stats") return datasetStats(url);
      if (url.pathname === "/research-api/langfuse/experiment-results") return json(await experimentResults(url));
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});

console.log(`research sidecar listening on http://localhost:${PORT}`);

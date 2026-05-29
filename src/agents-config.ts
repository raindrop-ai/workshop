import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const STATE_DIR = path.join(os.homedir(), ".raindrop");
const LEGACY_CONFIG_PATH = path.join(STATE_DIR, "agents.json");
const REPLAY_PROJECTS_PATH = path.join(STATE_DIR, "replay-projects.json");
const REPLAY_PORT_START = 61020;
const REPLAY_PORT_END = 61044;

export interface AgentConfig {
  eventName?: string;
  url?: string;
  cwd?: string;
  command?: string;
  configPath?: string;
  lastSeenPort?: number;
  input?: Record<string, string>;
  prefillFromTrace?: Record<string, string>;
  models?: string[];
  // Legacy alias kept while the UI/server move from agents.json to agents.yaml.
  contextFromTrace?: Record<string, string>;
}

export type AgentsConfig = Record<string, AgentConfig>;

export interface EnsureAgentEndpointResult {
  eventName: string;
  config: AgentConfig | null;
  registered: boolean;
  attemptedStart: boolean;
  command?: string;
  cwd?: string;
  logPath?: string;
  reason?: "not_registered" | "start_timeout";
}

interface ReplayProjectRegistryEntry {
  configPath: string;
  agents: Record<string, {
    cwd: string;
    command: string;
    lastSeenPort?: number;
    input?: Record<string, string>;
    prefillFromTrace?: Record<string, string>;
    models?: string[];
  }>;
}

type ReplayProjectsRegistry = Record<string, ReplayProjectRegistryEntry>;

interface ReplayHealthResponse {
  ok?: boolean;
  eventName?: string;
  port?: number;
  cwd?: string;
  command?: string;
  input?: Record<string, string>;
  prefillFromTrace?: Record<string, string>;
  models?: string[];
}

interface ParsedAgentConfig {
  cwd?: string;
  command?: string;
  input?: Record<string, string>;
  prefillFromTrace?: Record<string, string>;
  models?: string[];
}

interface RegisterReplayProjectOptions {
  validate?: boolean;
  startupTimeoutMs?: number;
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function loadAgentsConfig(): AgentsConfig {
  const merged: AgentsConfig = {};

  // Legacy manual registry. Kept for compatibility with existing installs.
  const legacy = sanitizeLegacyAgentsConfig(readJsonFile<AgentsConfig>(LEGACY_CONFIG_PATH, {}));
  Object.assign(merged, legacy);

  const projects = loadReplayProjectsRegistry();
  for (const [cwd, project] of Object.entries(projects)) {
    for (const [eventName, agent] of Object.entries(project.agents ?? {})) {
      const port = agent.lastSeenPort;
      merged[eventName] = {
        ...merged[eventName],
        cwd: agent.cwd || cwd,
        command: agent.command,
        configPath: project.configPath,
        lastSeenPort: port,
        url: port ? `http://127.0.0.1:${port}/replay` : merged[eventName]?.url,
        input: agent.input,
        prefillFromTrace: agent.prefillFromTrace,
        contextFromTrace: agent.prefillFromTrace ?? merged[eventName]?.contextFromTrace,
        models: agent.models,
      };
    }
  }

  return merged;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

export function sanitizeLegacyAgentsConfig(config: unknown): AgentsConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const sanitized: AgentsConfig = {};
  for (const [eventName, raw] of Object.entries(config)) {
    if (!eventName || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const agent: AgentConfig = {};
    if (typeof entry.url === "string" && entry.url.trim()) agent.url = entry.url.trim();
    const input = stringMap(entry.input);
    if (input) agent.input = input;
    const prefillFromTrace = stringMap(entry.prefillFromTrace);
    if (prefillFromTrace) agent.prefillFromTrace = prefillFromTrace;
    const contextFromTrace = stringMap(entry.contextFromTrace);
    if (contextFromTrace) agent.contextFromTrace = contextFromTrace;
    const models = stringList(entry.models);
    if (models) agent.models = models;
    if (Object.keys(agent).length > 0) sanitized[eventName] = agent;
  }
  return sanitized;
}

export function saveAgentsConfig(config: AgentsConfig): AgentsConfig {
  // Legacy settings UI still writes URL/context endpoint data to the old JSON
  // file. Command-bearing replay project registrations live in
  // ~/.raindrop/replay-projects.json and are created through explicit local
  // project registration, not this HTTP settings endpoint.
  const sanitized = sanitizeLegacyAgentsConfig(config);
  fs.mkdirSync(path.dirname(LEGACY_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(LEGACY_CONFIG_PATH, JSON.stringify(sanitized, null, 2));
  return sanitized;
}

export function loadReplayProjectsRegistry(): ReplayProjectsRegistry {
  return readJsonFile<ReplayProjectsRegistry>(REPLAY_PROJECTS_PATH, {});
}

function saveReplayProjectsRegistry(registry: ReplayProjectsRegistry): void {
  fs.mkdirSync(path.dirname(REPLAY_PROJECTS_PATH), { recursive: true });
  fs.writeFileSync(REPLAY_PROJECTS_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function stripYamlComment(line: string): string {
  // `#` only starts a YAML comment after whitespace; `foo#bar` stays whole.
  const match = line.match(/(?:^|\s)#/);
  return match ? line.slice(0, match.index) : line;
}

function splitYamlPair(line: string): [string, string] | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

function parseSimpleAgentsYaml(text: string): Record<string, ParsedAgentConfig> {
  const agents: Record<string, any> = {};
  let currentAgent: string | null = null;
  let section: "input" | "prefillFromTrace" | "models" | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const line = withoutComment.trim();

    if (indent === 0) {
      const pair = splitYamlPair(line);
      if (!pair) continue;
      currentAgent = pair[0];
      section = null;
      agents[currentAgent] = agents[currentAgent] ?? {};
      continue;
    }

    if (!currentAgent) continue;

    if (indent === 2) {
      const pair = splitYamlPair(line);
      if (!pair) continue;
      const [key, value] = pair;
      if (key === "input" || key === "prefillFromTrace" || key === "models") {
        section = key;
        agents[currentAgent][key] = key === "models" ? [] : {};
      } else {
        section = null;
        if (value) agents[currentAgent][key] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    if (indent >= 4 && section) {
      if (section === "models") {
        if (line.startsWith("- ")) agents[currentAgent].models.push(line.slice(2).trim().replace(/^["']|["']$/g, ""));
      } else {
        const pair = splitYamlPair(line);
        if (pair) agents[currentAgent][section][pair[0]] = pair[1].replace(/^["']|["']$/g, "");
      }
    }
  }

  return agents;
}

export function getAgentsYamlPath(cwd: string): string {
  return path.join(cwd, ".raindrop", "agents.yaml");
}

function resolveAgentCwd(projectCwd: string, agentCwd: string | undefined): string {
  if (!agentCwd) return projectCwd;
  return path.resolve(projectCwd, agentCwd);
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  return path.resolve(a) === path.resolve(b);
}

function healthMatchesAgent(eventName: string, expected: AgentConfig, actual: AgentConfig | null): actual is AgentConfig {
  if (!actual?.url) return false;
  if (actual.eventName && normalizeEventName(actual.eventName) !== normalizeEventName(eventName)) return false;
  return samePath(expected.cwd, actual.cwd);
}

function findRegisteredProjectForEvent(registry: ReplayProjectsRegistry, eventName: string): [string, ReplayProjectRegistryEntry] | null {
  const normalized = normalizeEventName(eventName);
  for (const [projectCwd, project] of Object.entries(registry)) {
    if (project.agents?.[normalized]) return [projectCwd, project];
  }
  return null;
}

async function findHealthyAgent(eventName: string, expected: AgentConfig): Promise<AgentConfig | null> {
  const healthy = await isAgentHealthy(expected);
  if (healthMatchesAgent(eventName, expected, healthy)) return { ...expected, ...healthy };

  const discovered = await discoverReplayAgents();
  const discoveredAgent = discovered[normalizeEventName(eventName)];
  if (healthMatchesAgent(eventName, expected, discoveredAgent)) return { ...expected, ...discoveredAgent };

  return null;
}

async function validateReplayAgentStartup(
  eventName: string,
  config: AgentConfig,
  timeoutMs: number,
): Promise<{ config: AgentConfig; attemptedStart: boolean; logPath?: string }> {
  const alreadyHealthy = await findHealthyAgent(eventName, config);
  if (alreadyHealthy) return { config: alreadyHealthy, attemptedStart: false, logPath: replayLogPath(config) ?? undefined };

  const logPath = spawnReplayCommand(config) ?? replayLogPath(config) ?? undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const healthy = await findHealthyAgent(eventName, config);
    if (healthy) return { config: healthy, attemptedStart: true, logPath };
  }

  throw new Error(
    `Agent "${eventName}" in ${config.configPath ?? "agents.yaml"} did not become healthy within ${Math.round(timeoutMs / 1000)}s.\n` +
      `  command: ${config.command}\n` +
      `  cwd: ${config.cwd}\n` +
      (logPath ? `  log: ${logPath}\n` : "") +
      `Fix the command/cwd, then run \`raindrop replay register\` again.`,
  );
}

export async function registerReplayProject(
  cwd = process.cwd(),
  opts: RegisterReplayProjectOptions = {},
): Promise<{ cwd: string; configPath: string; agents: string[] }> {
  const resolvedCwd = path.resolve(cwd);
  const configPath = getAgentsYamlPath(resolvedCwd);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No .raindrop/agents.yaml found in ${resolvedCwd}`);
  }
  const parsed = parseSimpleAgentsYaml(fs.readFileSync(configPath, "utf8"));
  const registry = loadReplayProjectsRegistry();
  const existingProject = registry[resolvedCwd];
  const agentEntries: ReplayProjectRegistryEntry["agents"] = {};
  for (const [eventName, config] of Object.entries(parsed)) {
    if (!config.command) {
      throw new Error(`Agent "${eventName}" in ${configPath} is missing command`);
    }
    const agentCwd = resolveAgentCwd(resolvedCwd, config.cwd);
    const existingAgent = existingProject?.agents?.[eventName];
    let entry: ReplayProjectRegistryEntry["agents"][string] = {
      cwd: agentCwd,
      command: config.command,
      lastSeenPort: samePath(existingAgent?.cwd, agentCwd) ? existingAgent?.lastSeenPort : undefined,
      input: config.input ?? {},
      prefillFromTrace: config.prefillFromTrace ?? {},
      models: config.models,
    };

    if (opts.validate !== false) {
      const validated = await validateReplayAgentStartup(
        eventName,
        {
          eventName,
          ...entry,
          configPath,
        },
        opts.startupTimeoutMs ?? 10_000,
      );
      entry = {
        ...entry,
        cwd: validated.config.cwd ?? agentCwd,
        command: validated.config.command ?? entry.command,
        lastSeenPort: validated.config.lastSeenPort ?? entry.lastSeenPort,
      };
    }

    agentEntries[eventName] = {
      ...entry,
    };
  }
  registry[resolvedCwd] = { configPath, agents: agentEntries };
  saveReplayProjectsRegistry(registry);
  return { cwd: resolvedCwd, configPath, agents: Object.keys(agentEntries) };
}

export async function registerReplayProjectIfPresent(cwd: string): Promise<boolean> {
  try {
    const configPath = getAgentsYamlPath(path.resolve(cwd));
    if (!fs.existsSync(configPath)) return false;
    await registerReplayProject(cwd, { validate: false });
    return true;
  } catch {
    return false;
  }
}

export function getAgentEndpoint(eventName: string): AgentConfig | null {
  const config = loadAgentsConfig();
  return config[eventName] ?? null;
}

function normalizeEventName(name: string): string {
  return name.replace(/^replay:/, "");
}

async function probeReplayHealth(port: number): Promise<AgentConfig | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(600),
    });
    if (!res.ok) return null;
    const body = await res.json() as ReplayHealthResponse;
    if (body.ok !== true || typeof body.eventName !== "string") return null;
    const eventName = normalizeEventName(body.eventName);
    const seenPort = Number.isInteger(body.port) ? body.port! : port;
    const config: AgentConfig = {
      eventName,
      url: `http://127.0.0.1:${seenPort}/replay`,
      cwd: body.cwd,
      command: body.command,
      lastSeenPort: seenPort,
      input: body.input ?? {},
      prefillFromTrace: body.prefillFromTrace ?? {},
      contextFromTrace: body.prefillFromTrace ?? {},
      models: body.models,
    };
    return { ...config, configPath: body.cwd ? getAgentsYamlPath(body.cwd) : undefined };
  } catch {
    return null;
  }
}

// Batched: one read-modify-write per call. Fan-out callers must pass every
// entry in a single call, not loop one-at-a-time, to avoid racing writes.
function applyHealthDiscoveries(entries: Array<[string, AgentConfig]>): void {
  const usable = entries.filter(([, c]) => c.cwd && c.command);
  if (usable.length === 0) return;
  const registry = loadReplayProjectsRegistry();
  for (const [eventName, config] of usable) {
    const cwd = path.resolve(config.cwd!);
    const existingRegisteredProject = findRegisteredProjectForEvent(registry, eventName);
    const projectCwd = existingRegisteredProject?.[0] ?? cwd;
    const existing = existingRegisteredProject?.[1] ?? registry[projectCwd] ?? { configPath: getAgentsYamlPath(projectCwd), agents: {} };
    existing.agents[eventName] = {
      cwd,
      command: config.command!,
      lastSeenPort: config.lastSeenPort,
      input: config.input,
      prefillFromTrace: config.prefillFromTrace,
      models: config.models,
    };
    registry[projectCwd] = existing;
  }
  saveReplayProjectsRegistry(registry);
}

function updateRegistryFromHealth(eventName: string, config: AgentConfig): void {
  applyHealthDiscoveries([[eventName, config]]);
}

export async function discoverReplayAgents(): Promise<AgentsConfig> {
  const discovered: AgentsConfig = {};
  await Promise.all(
    Array.from({ length: REPLAY_PORT_END - REPLAY_PORT_START + 1 }, async (_, i) => {
      const port = REPLAY_PORT_START + i;
      const config = await probeReplayHealth(port);
      if (config?.eventName && config.url) discovered[config.eventName] = config;
    }),
  );
  applyHealthDiscoveries(Object.entries(discovered));
  return discovered;
}

async function isAgentHealthy(config: AgentConfig): Promise<AgentConfig | null> {
  const port = config.lastSeenPort ?? (config.url ? Number(new URL(config.url).port) : null);
  if (!port) return null;
  const healthy = await probeReplayHealth(port);
  if (healthy?.eventName) updateRegistryFromHealth(healthy.eventName, healthy);
  return healthy;
}

function replayLogPath(config: AgentConfig): string | null {
  if (!config.cwd) return null;
  return path.join(STATE_DIR, `replay-${path.basename(config.cwd)}.log`);
}

function spawnReplayCommand(config: AgentConfig): string | null {
  if (!config.cwd || !config.command) return null;
  const logPath = path.join(STATE_DIR, `replay-${path.basename(config.cwd)}.log`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(config.command, {
    cwd: config.cwd,
    shell: true,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      RAINDROP_LOCAL_DEBUGGER: process.env.RAINDROP_LOCAL_DEBUGGER ?? "http://localhost:5899/v1/",
    },
  });
  child.unref();
  // Child has its own copy via stdio.
  fs.closeSync(out);
  return logPath;
}

export async function ensureAgentEndpointDetailed(eventName: string): Promise<EnsureAgentEndpointResult> {
  const name = normalizeEventName(eventName);
  let config = getAgentEndpoint(name);
  if (config) {
    const healthy = await isAgentHealthy(config);
    if (healthy?.url) {
      return {
        eventName: name,
        config: { ...config, ...healthy },
        registered: true,
        attemptedStart: false,
        command: config.command,
        cwd: config.cwd,
        logPath: replayLogPath(config) ?? undefined,
      };
    }
  }

  const discovered = await discoverReplayAgents();
  if (discovered[name]?.url) {
    return {
      eventName: name,
      config: discovered[name],
      registered: true,
      attemptedStart: false,
      command: discovered[name].command,
      cwd: discovered[name].cwd,
      logPath: replayLogPath(discovered[name]) ?? undefined,
    };
  }

  config = getAgentEndpoint(name);
  if (!config?.command || !config.cwd) {
    return {
      eventName: name,
      config: null,
      registered: false,
      attemptedStart: false,
      reason: "not_registered",
    };
  }
  const logPath = spawnReplayCommand(config) ?? replayLogPath(config) ?? undefined;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const healthy = await isAgentHealthy(config);
    if (healthy?.url) {
      return {
        eventName: name,
        config: { ...config, ...healthy },
        registered: true,
        attemptedStart: true,
        command: config.command,
        cwd: config.cwd,
        logPath,
      };
    }
    const rescanned = await discoverReplayAgents();
    if (rescanned[name]?.url) {
      return {
        eventName: name,
        config: rescanned[name],
        registered: true,
        attemptedStart: true,
        command: config.command,
        cwd: config.cwd,
        logPath,
      };
    }
  }

  return {
    eventName: name,
    config: null,
    registered: true,
    attemptedStart: true,
    command: config.command,
    cwd: config.cwd,
    logPath,
    reason: "start_timeout",
  };
}

export async function ensureAgentEndpoint(eventName: string): Promise<AgentConfig | null> {
  return (await ensureAgentEndpointDetailed(eventName)).config;
}

export const _internal = {
  parseSimpleAgentsYaml,
  resolveAgentCwd,
  healthMatchesAgent,
};

/**
 * Extract agent-specific context from a run's span attributes using the
 * contextFromTrace mapping defined in agents.json.
 */
export function extractContextFromTrace(
  spans: any[],
  contextMapping: Record<string, string>,
): Record<string, any> {
  const allAttrs: Record<string, any> = {};
  for (const span of spans) {
    if (!span.attributes) continue;
    try {
      const attrs = typeof span.attributes === "string" ? JSON.parse(span.attributes) : span.attributes;
      for (const [k, v] of Object.entries(attrs)) {
        if (!allAttrs[k]) allAttrs[k] = v;
      }
    } catch {}
  }

  const propsStr = allAttrs["ai.telemetry.metadata.raindrop.properties"];
  let props: Record<string, any> = {};
  if (propsStr) {
    try { props = typeof propsStr === "string" ? JSON.parse(propsStr) : propsStr; } catch {}
  }

  const context: Record<string, any> = {};
  for (const [field, attrPath] of Object.entries(contextMapping)) {
    if (allAttrs[attrPath] !== undefined) {
      context[field] = allAttrs[attrPath];
      continue;
    }
    if (attrPath.startsWith("properties.")) {
      const propKey = attrPath.slice("properties.".length);
      if (props[propKey] !== undefined) {
        context[field] = props[propKey];
        continue;
      }
    }
    const raindropPrefix = "ai.telemetry.metadata.raindrop.properties.";
    if (attrPath.startsWith(raindropPrefix)) {
      const propKey = attrPath.slice(raindropPrefix.length);
      if (props[propKey] !== undefined) {
        context[field] = props[propKey];
        continue;
      }
    }
    const metaPrefix = "ai.telemetry.metadata.raindrop.";
    if (attrPath.startsWith(metaPrefix)) {
      const metaKey = metaPrefix + attrPath.slice(metaPrefix.length);
      if (allAttrs[metaKey] !== undefined) {
        context[field] = allAttrs[metaKey];
        continue;
      }
    }
    if (props[attrPath] !== undefined) {
      context[field] = props[attrPath];
    }
  }

  return context;
}

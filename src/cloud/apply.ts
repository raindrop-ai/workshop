import {
  installMcpServerForAgent,
  isMcpAgentType,
  type McpServerConfig,
} from "agent-install/mcp";
import {
  installSkillsFromSource,
  isSkillAgentType,
  type FailedSkillRecord,
  type InstalledSkillRecord,
  type SkillAgentType,
} from "agent-install/skill";

import { CLOUD_MCP_SERVER_NAME, HOSTED_MCP_URL } from "../auth/constants";
import { VERSION } from "../version";
import {
  installCustomMcpServerForAgent,
  supportsCustomMcpAgent,
  type CustomMcpInstallResult,
} from "../install/custom-mcp";
import {
  entryFromInstallPlanItem,
  loadInstallRegistry,
  saveInstallRegistry,
  upsertInstallRegistryEntry,
} from "../install/registry";
import type { InstallAgentId, InstallPlan } from "../install/types";
import { CLOUD_SKILL_NAMES, cloudInstallRegistryPath } from "./constants";
import { fetchSkillBundle, type FetchSkillBundleOptions } from "./skills";

export interface ApplyCloudInstallOptions {
  /** Registry file. Defaults to the cloud registry (separate from Workshop's). */
  registryFile?: string;
  skills?: FetchSkillBundleOptions;
  /** Override the hosted MCP URL written into agent configs (staging/testing). */
  serverUrl?: string;
}

export interface ApplyCloudInstallItemResult {
  agent: InstallAgentId;
  skillsInstalled: InstalledSkillRecord[];
  skillsFailed: FailedSkillRecord[];
  mcp: CustomMcpInstallResult;
}

export interface ApplyCloudInstallResult {
  skillsRef: string;
  skillsDir: string;
  items: ApplyCloudInstallItemResult[];
}

/**
 * Hosted MCP config. No auth header is written — each agent runs its own OAuth
 * against the hosted server on first use, so no secret is persisted to disk.
 * Honors a `--server-url` override so a staging/test run wires agents to the
 * same endpoint that auth + write-key fetch target (not always production).
 */
export function buildHostedMcpConfig(serverUrl?: string): McpServerConfig {
  return { type: "http", url: serverUrl ?? HOSTED_MCP_URL };
}

function assertFullSupport(
  agent: InstallAgentId,
  scope: "global" | "local",
): asserts agent is SkillAgentType {
  if (!isSkillAgentType(agent) || (!isMcpAgentType(agent) && !supportsCustomMcpAgent(agent, scope))) {
    throw new Error(`cloud install: ${agent} does not support both Raindrop skills and MCP`);
  }
}

/**
 * Apply the cloud install: wire the hosted HTTP MCP (named `raindrop`) and the
 * cloud skills for each chosen agent, recording entries in the cloud-only
 * registry. Unlike the local installer this never registers a daemon and never
 * touches Workshop's `workshop` MCP entry or its `install-registry.json`.
 */
export async function applyCloudInstallPlan(
  plan: InstallPlan,
  opts: ApplyCloudInstallOptions = {},
): Promise<ApplyCloudInstallResult> {
  const bundle = await fetchSkillBundle(opts.skills);
  const mcpConfig = buildHostedMcpConfig(opts.serverUrl);
  const registryFile = opts.registryFile ?? cloudInstallRegistryPath();
  const registry = loadInstallRegistry(registryFile);
  const results: ApplyCloudInstallItemResult[] = [];

  for (const item of plan.items) {
    assertFullSupport(item.agent, item.scope);
    const isGlobal = item.scope === "global";
    const cwd = item.cwd ?? process.cwd();

    const skills = await installSkillsFromSource({
      source: bundle.skillsDir,
      skills: [...CLOUD_SKILL_NAMES],
      agents: [item.agent],
      global: isGlobal,
      cwd,
      mode: "symlink",
    });

    const mcp: CustomMcpInstallResult = isMcpAgentType(item.agent)
      ? installMcpServerForAgent(CLOUD_MCP_SERVER_NAME, mcpConfig, item.agent, {
          global: isGlobal,
          cwd,
        })
      : installCustomMcpServerForAgent(CLOUD_MCP_SERVER_NAME, mcpConfig, item.agent, item.scope);

    results.push({
      agent: item.agent,
      skillsInstalled: skills.installed,
      skillsFailed: skills.failed,
      mcp,
    });

    // Record whenever any artifact landed (skills and/or MCP) so a partial
    // install is still cleanable — not only when both succeed.
    if (skills.installed.length > 0 || mcp.success) {
      upsertInstallRegistryEntry(registry, entryFromInstallPlanItem(item, VERSION));
    }
  }

  saveInstallRegistry(registry, registryFile);
  return { skillsRef: bundle.ref, skillsDir: bundle.skillsDir, items: results };
}

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  getMcpAgentConfig,
  isMcpAgentType,
  listServersInConfigFile,
  removeMcpServerFromAgent,
  removeServerFromConfigFile,
  resolveMcpConfigTarget,
  type McpAgentType,
} from "agent-install/mcp";
import type { InstallAgentId, InstallScope } from "./types";

export const CANONICAL_MCP_SERVER_NAME = "workshop";
export const MCP_FINGERPRINT_ARGS = ["workshop", "mcp"] as const;

export interface OwnedMcpEntry {
  serverName: string;
  agent: InstallAgentId;
  path: string;
  matchedBy: "args" | "command";
}

interface RawServerConfig {
  command?: unknown;
  args?: unknown;
}

function stripExeSuffix(name: string): string {
  return name.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
}

function commandBasenameLooksOwned(command: unknown): boolean {
  if (typeof command !== "string" || !command) return false;
  const base = stripExeSuffix(path.basename(command));
  return base === "raindrop" || base === CANONICAL_MCP_SERVER_NAME;
}

function argsEndWithFingerprint(args: unknown): boolean {
  if (!Array.isArray(args) || args.length < MCP_FINGERPRINT_ARGS.length) return false;
  const tail = args.slice(args.length - MCP_FINGERPRINT_ARGS.length);
  return MCP_FINGERPRINT_ARGS.every((expected, i) => tail[i] === expected);
}

export function classifyOwnership(rawConfig: unknown): "args" | "command" | null {
  if (!rawConfig || typeof rawConfig !== "object") return null;
  const cfg = rawConfig as RawServerConfig;
  if (argsEndWithFingerprint(cfg.args)) return "args";
  if (commandBasenameLooksOwned(cfg.command)) return "command";
  return null;
}

const WINDSURF_CONFIG_RELATIVE = path.join(".codeium", "windsurf", "mcp_config.json");

function windsurfConfigPath(homeDir: string): string {
  return path.join(homeDir, WINDSURF_CONFIG_RELATIVE);
}

export interface FindOwnedOptions {
  agent: InstallAgentId;
  scope: InstallScope;
  cwd?: string;
  homeDir?: string;
  // When set, an owned entry with this server name is left untouched. Install
  // uses it to keep the freshly written canonical entry while still clearing
  // legacy duplicates; uninstall omits it so every owned entry is removed.
  excludeServerName?: string;
}

export function findOwnedMcpEntries(opts: FindOwnedOptions): OwnedMcpEntry[] {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const isGlobal = opts.scope === "global";

  if (isMcpAgentType(opts.agent)) {
    const agentType = opts.agent as McpAgentType;
    const agentConfig = getMcpAgentConfig(agentType);
    const { configPath, configKey } = resolveMcpConfigTarget(agentConfig, { global: isGlobal, cwd });
    return collectOwnedFromConfig(configPath, agentConfig.format, configKey, opts.agent, opts.excludeServerName);
  }

  if (opts.agent === "windsurf" && isGlobal) {
    return collectOwnedFromConfig(windsurfConfigPath(homeDir), "jsonc", "mcpServers", opts.agent, opts.excludeServerName);
  }

  return [];
}

function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function collectOwnedFromConfig(
  configPath: string,
  format: Parameters<typeof listServersInConfigFile>[1],
  configKey: string,
  agent: InstallAgentId,
  excludeServerName?: string,
): OwnedMcpEntry[] {
  if (!fs.existsSync(configPath)) return [];
  if (!isExistingFile(configPath)) {
    throw new Error(`MCP config at ${configPath} is not a regular file`);
  }
  const entries = listServersInConfigFile(configPath, format, configKey);
  const result: OwnedMcpEntry[] = [];
  for (const [serverName, rawConfig] of Object.entries(entries)) {
    if (excludeServerName !== undefined && serverName === excludeServerName) continue;
    const matchedBy = classifyOwnership(rawConfig);
    if (matchedBy) result.push({ serverName, agent, path: configPath, matchedBy });
  }
  return result;
}

export interface RemoveOwnedResult {
  entry: OwnedMcpEntry;
  removed: boolean;
  error?: string;
}

export function removeOwnedMcpEntries(opts: FindOwnedOptions): RemoveOwnedResult[] {
  const cwd = opts.cwd ?? process.cwd();
  const isGlobal = opts.scope === "global";
  const owned = findOwnedMcpEntries(opts);
  const results: RemoveOwnedResult[] = [];

  for (const entry of owned) {
    if (isMcpAgentType(entry.agent)) {
      const agentType = entry.agent as McpAgentType;
      try {
        const r = removeMcpServerFromAgent(entry.serverName, agentType, { global: isGlobal, cwd });
        results.push({ entry, removed: r.removed, error: r.error });
      } catch (err) {
        results.push({ entry, removed: false, error: (err as Error).message });
      }
      continue;
    }
    if (entry.agent === "windsurf") {
      try {
        const removed = removeServerFromConfigFile(entry.path, "jsonc", "mcpServers", entry.serverName);
        results.push({ entry, removed });
      } catch (err) {
        results.push({ entry, removed: false, error: (err as Error).message });
      }
    }
  }

  return results;
}

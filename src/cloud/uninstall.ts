import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCanonicalSkillsDir,
  getSkillAgentDir,
  isSkillAgentType,
  sanitizeName,
} from "agent-install/skill";
import {
  getMcpAgentConfig,
  isMcpAgentType,
  listServersInConfigFile,
  removeMcpServerFromAgent,
  removeServerFromConfigFile,
  resolveMcpConfigTarget,
  type McpAgentType,
  type McpConfigFormat,
} from "agent-install/mcp";

import { CLOUD_MCP_SERVER_NAME } from "../auth/constants";
import { getSupportedInstallAgents } from "../install/detect";
import {
  installRegistryId,
  loadInstallRegistry,
  type InstallRegistryEntry,
} from "../install/registry";
import type { InstallAgentId } from "../install/types";
import { VERSION } from "../version";
import { CLOUD_SKILL_NAMES, cloudInstallRegistryPath } from "./constants";
import { removeWriteKeyFromEnv } from "./env-file";

class UsageError extends Error {}

interface ParsedArgs {
  wipe: boolean;
  yes: boolean;
  dryRun: boolean;
  cwd: string;
  registryFile: string | null;
}

export interface RunCloudUninstallOptions {
  wipe?: boolean;
  dryRun?: boolean;
  cwd?: string;
  registryFile?: string;
}

export interface RunCloudUninstallResult {
  ok: boolean;
  dryRun: boolean;
  removed: string[];
  warnings: string[];
  failures: string[];
}

interface Sink {
  dryRun: boolean;
  removed: string[];
  failures: string[];
}

const WINDSURF_MCP_CONFIG = path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    wipe: false,
    yes: false,
    dryRun: false,
    cwd: process.cwd(),
    registryFile: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wipe") out.wipe = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--cwd=")) out.cwd = path.resolve(requireValue("--cwd", arg.slice("--cwd=".length)));
    else if (arg === "--cwd") out.cwd = path.resolve(takeValue(argv, i++, arg));
    else if (arg.startsWith("--registry-file=")) out.registryFile = requireValue("--registry-file", arg.slice("--registry-file=".length));
    else if (arg === "--registry-file") out.registryFile = takeValue(argv, i++, arg);
    else if (arg === "-h" || arg === "--help") {
      printCloudUninstallHelp();
      process.exit(0);
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }

  return out;
}

function requireValue(flag: string, value: string): string {
  if (value === "") throw new UsageError(`${flag} requires a value`);
  return value;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

export function printCloudUninstallHelp(): void {
  console.log(`raindrop cloud uninstall ${VERSION} — remove Raindrop cloud from your agents

USAGE
    raindrop cloud uninstall [--wipe] [--yes] [--dry-run]

WHAT IT DOES
    Removes the hosted Raindrop MCP server and the cloud skills that
    \`raindrop cloud setup\` installed into your AI coding agents, then clears
    the cloud install registry. The local Workshop install (the \`workshop\`
    MCP + daemon) is never touched — use \`raindrop uninstall\` for that.

FLAGS
    --wipe       Also remove RAINDROP_WRITE_KEY from ./.env and ./.env.example.
    -y, --yes    Skip the confirmation prompt.
    --dry-run    Print what would be removed without modifying files.
    --cwd=<dir>  Project directory for local-scope cleanup (default: cwd).
`);
}

/** Resolve the MCP config file + format + dotted key for an agent so we can
 * inspect it before removing only a hosted (http) `raindrop` entry. Returns
 * null for agents that don't carry a cloud MCP entry. */
function resolveCloudMcpTarget(
  agent: InstallAgentId,
  isGlobal: boolean,
  cwd: string,
): { configPath: string; format: McpConfigFormat; configKey: string } | null {
  if (isMcpAgentType(agent)) {
    const agentConfig = getMcpAgentConfig(agent as McpAgentType);
    const { configPath, configKey } = resolveMcpConfigTarget(agentConfig, { global: isGlobal, cwd });
    return { configPath, format: agentConfig.format, configKey };
  }
  if (agent === "windsurf" && isGlobal) {
    return { configPath: WINDSURF_MCP_CONFIG, format: "jsonc", configKey: "mcpServers" };
  }
  return null;
}

/** True only for the cloud MCP we wrote: a hosted (remote) server. Each agent
 * encodes the same hosted endpoint differently — `{ type: "http", url }` for
 * most, `{ type: "remote", url, enabled }` for opencode, etc. — so we key off
 * the transport-agnostic signal: a remote server has a `url` and no local
 * `command`. This guards against deleting an unrelated server that happens to
 * be named `raindrop` (e.g. a legacy stdio `{ command, args }` entry from
 * before the MCP rename), which we never own. */
function isHostedCloudMcp(rawConfig: unknown): boolean {
  if (typeof rawConfig !== "object" || rawConfig === null) return false;
  const cfg = rawConfig as { url?: unknown; command?: unknown };
  return typeof cfg.url === "string" && cfg.url !== "" && cfg.command === undefined;
}

function removeCloudMcpForEntry(entry: InstallRegistryEntry, opts: Sink): void {
  const isGlobal = entry.scope === "global";
  const cwd = entry.cwd ?? process.cwd();
  const target = resolveCloudMcpTarget(entry.agent, isGlobal, cwd);
  if (!target) return;

  let servers: Record<string, unknown>;
  try {
    if (!fs.existsSync(target.configPath)) {
      opts.removed.push(`no ${entry.agent} cloud MCP entry to remove (${entry.scope})`);
      return;
    }
    servers = listServersInConfigFile(target.configPath, target.format, target.configKey);
  } catch (err) {
    opts.failures.push(`failed to read ${entry.agent} MCP config ${target.configPath}: ${(err as Error).message}`);
    return;
  }

  const rawConfig = servers[CLOUD_MCP_SERVER_NAME];
  if (rawConfig === undefined) {
    opts.removed.push(`no ${entry.agent} cloud MCP entry to remove (${entry.scope})`);
    return;
  }
  if (!isHostedCloudMcp(rawConfig)) {
    // A non-hosted server named `raindrop` is not ours; leave it untouched.
    opts.failures.push(
      `left ${entry.agent} MCP '${CLOUD_MCP_SERVER_NAME}' in place (${target.configPath}): not a hosted (http) cloud entry`,
    );
    return;
  }

  if (opts.dryRun) {
    opts.removed.push(`would remove ${entry.agent} cloud MCP '${CLOUD_MCP_SERVER_NAME}' (${entry.scope}) from ${target.configPath}`);
    return;
  }

  try {
    if (isMcpAgentType(entry.agent)) {
      const r = removeMcpServerFromAgent(CLOUD_MCP_SERVER_NAME, entry.agent as McpAgentType, {
        global: isGlobal,
        cwd,
      });
      if (r.error) {
        opts.failures.push(`failed to remove ${entry.agent} cloud MCP from ${r.path}: ${r.error}`);
      } else if (r.removed) {
        opts.removed.push(`removed ${entry.agent} cloud MCP '${CLOUD_MCP_SERVER_NAME}' from ${r.path}`);
      } else {
        // We verified the hosted entry exists above, so a no-op removal means
        // it unexpectedly survived; fail so the registry is retained for retry.
        opts.failures.push(`failed to remove ${entry.agent} cloud MCP '${CLOUD_MCP_SERVER_NAME}' from ${r.path}: entry still present`);
      }
      return;
    }
    const removed = removeServerFromConfigFile(target.configPath, target.format, target.configKey, CLOUD_MCP_SERVER_NAME);
    if (removed) {
      opts.removed.push(`removed ${entry.agent} cloud MCP '${CLOUD_MCP_SERVER_NAME}' from ${target.configPath}`);
    } else {
      opts.failures.push(`failed to remove ${entry.agent} cloud MCP '${CLOUD_MCP_SERVER_NAME}' from ${target.configPath}: entry still present`);
    }
  } catch (err) {
    opts.failures.push(`failed to remove ${entry.agent} cloud MCP: ${(err as Error).message}`);
  }
}

function removeCloudSkillsForEntry(entry: InstallRegistryEntry, opts: Sink): void {
  if (!isSkillAgentType(entry.agent)) return;
  const isGlobal = entry.scope === "global";
  const cwd = entry.cwd ?? process.cwd();

  for (const skill of CLOUD_SKILL_NAMES) {
    const name = sanitizeName(skill);
    removePath(
      path.join(getCanonicalSkillsDir(isGlobal, cwd), name),
      `${entry.scope} canonical skill ${name}`,
      opts,
    );
    removePath(
      path.join(getSkillAgentDir(entry.agent, { global: isGlobal, cwd }), name),
      `${entry.agent} skill ${name}`,
      opts,
    );
  }
}

function removePath(target: string, label: string, opts: Sink): void {
  if (opts.dryRun) {
    if (fs.existsSync(target)) opts.removed.push(`would remove ${label}: ${target}`);
    return;
  }
  try {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    opts.removed.push(`removed ${label}: ${target}`);
  } catch (err) {
    opts.failures.push(`failed to remove ${label} ${target}: ${(err as Error).message}`);
  }
}

function removeFile(file: string, label: string, opts: Sink): void {
  if (opts.dryRun) {
    if (fs.existsSync(file)) opts.removed.push(`would remove ${label}: ${file}`);
    return;
  }
  try {
    if (!fs.existsSync(file)) return;
    fs.rmSync(file, { force: true });
    opts.removed.push(`removed ${label}: ${file}`);
  } catch (err) {
    opts.failures.push(`failed to remove ${label} ${file}: ${(err as Error).message}`);
  }
}

/** Best-effort entries when the cloud registry is missing/unreadable: every
 * agent that `cloud setup` could have targeted, for both scopes. */
function fallbackEntries(cwd: string): InstallRegistryEntry[] {
  const now = new Date().toISOString();
  const entries: InstallRegistryEntry[] = [];

  for (const scope of ["global", "local"] as const) {
    const agents = getSupportedInstallAgents({ scope, cwd })
      .filter((agent) => agent.supportsSkills && agent.supportsMcp)
      .map((agent) => agent.agent);
    for (const agent of agents) {
      const entryCwd = scope === "local" ? cwd : null;
      entries.push({
        id: installRegistryId(agent, scope, entryCwd),
        agent,
        scope,
        cwd: entryCwd,
        installer: "agent-install",
        raindropVersion: VERSION,
        installedAt: now,
        updatedAt: now,
      });
    }
  }
  return entries;
}

function loadEntries(opts: {
  registryFile: string;
  cwd: string;
  warnings: string[];
}): { entries: InstallRegistryEntry[]; registryLoaded: boolean } {
  try {
    const registry = loadInstallRegistry(opts.registryFile);
    if (registry.installs.length === 0) {
      opts.warnings.push("cloud install registry is empty; falling back to best-effort cleanup");
      return { entries: fallbackEntries(opts.cwd), registryLoaded: false };
    }
    return { entries: registry.installs, registryLoaded: true };
  } catch (err) {
    opts.warnings.push(
      `could not read cloud install registry at ${opts.registryFile}: ${(err as Error).message}; falling back to best-effort cleanup`,
    );
    return { entries: fallbackEntries(opts.cwd), registryLoaded: false };
  }
}

/** Project dirs whose `./.env` should be wiped: always the uninstall cwd (the
 * documented target, and the only signal for a global-scope setup whose project
 * path isn't recorded), plus every distinct local-scope entry cwd from the
 * registry, since `cloud setup` writes the key under the setup cwd. */
function wipeTargetDirs(cwd: string, entries: InstallRegistryEntry[]): string[] {
  const dirs = new Set<string>([path.resolve(cwd)]);
  for (const entry of entries) {
    if (entry.scope === "local" && entry.cwd) dirs.add(path.resolve(entry.cwd));
  }
  return [...dirs];
}

function wipeWriteKey(cwd: string, opts: Sink): void {
  if (opts.dryRun) {
    opts.removed.push(`would remove RAINDROP_WRITE_KEY from ${path.join(cwd, ".env")} (and .env.example placeholder)`);
    return;
  }
  try {
    const result = removeWriteKeyFromEnv({ cwd });
    if (result.removedFromEnv) opts.removed.push(`removed RAINDROP_WRITE_KEY from ${result.envPath}`);
    if (result.removedFromExample) opts.removed.push(`removed RAINDROP_WRITE_KEY placeholder from ${result.examplePath}`);
  } catch (err) {
    opts.failures.push(`failed to remove RAINDROP_WRITE_KEY from ${path.join(cwd, ".env")}: ${(err as Error).message}`);
  }
}

export async function runCloudUninstall(opts: RunCloudUninstallOptions = {}): Promise<RunCloudUninstallResult> {
  const cwd = opts.cwd ?? process.cwd();
  const registryFile = opts.registryFile ?? cloudInstallRegistryPath();
  const dryRun = Boolean(opts.dryRun);
  const wipe = Boolean(opts.wipe);
  const removed: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const sink: Sink = { dryRun, removed, failures };

  const { entries, registryLoaded } = loadEntries({ registryFile, cwd, warnings });
  for (const entry of entries) {
    removeCloudMcpForEntry(entry, sink);
    removeCloudSkillsForEntry(entry, sink);
  }

  // Only drop the registry when cleanup fully succeeded, so a re-run can retry
  // anything that failed. A fallback run never wrote the registry, so there's
  // nothing to clear.
  if (failures.length === 0 && registryLoaded) {
    removeFile(registryFile, "cloud install registry", sink);
  } else if (registryLoaded) {
    warnings.push(`kept cloud install registry for retry because cleanup had failures: ${registryFile}`);
  }

  if (wipe) {
    for (const dir of wipeTargetDirs(cwd, entries)) wipeWriteKey(dir, sink);
  }

  return { ok: failures.length === 0, dryRun, removed, warnings, failures };
}

async function confirmCloudUninstall(wipe: boolean): Promise<boolean> {
  const detail = wipe
    ? "This will remove the Raindrop cloud MCP + skills from your agents and delete RAINDROP_WRITE_KEY from ./.env."
    : "This will remove the Raindrop cloud MCP + skills from your agents. Your ./.env write key is preserved.";
  console.error(detail);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Type "Y" to continue: ');
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function printResult(result: RunCloudUninstallResult): void {
  for (const warning of result.warnings) console.warn(`[cloud uninstall] warning: ${warning}`);
  for (const item of result.removed) console.log(`[cloud uninstall] ${item}`);
  for (const failure of result.failures) console.error(`[cloud uninstall] ${failure}`);
  if (result.dryRun) {
    console.log("[cloud uninstall] dry run complete; no changes made.");
  } else if (result.ok) {
    console.log("[cloud uninstall] complete.");
  }
}

export async function cmdCloudUninstall(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      console.error("run `raindrop cloud uninstall --help` for usage.");
      return 64;
    }
    throw err;
  }

  if (!args.yes && !args.dryRun) {
    const ok = await confirmCloudUninstall(args.wipe);
    if (!ok) {
      console.error("cloud uninstall cancelled");
      return 1;
    }
  }

  const result = await runCloudUninstall({
    wipe: args.wipe,
    dryRun: args.dryRun,
    cwd: args.cwd,
    registryFile: args.registryFile ?? undefined,
  });
  printResult(result);
  return result.ok ? 0 : 1;
}

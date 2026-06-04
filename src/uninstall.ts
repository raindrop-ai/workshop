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
import { SKILLS } from "./init-skills";
import { getSupportedInstallAgents } from "./install/detect";
import {
  installRegistryId,
  loadInstallRegistry,
  type InstallRegistryEntry,
} from "./install/registry";
import { findOwnedMcpEntries, removeOwnedMcpEntries } from "./install/owned-mcp";
import { disableWorkshopStartup, type WorkshopStartupDisableOptions } from "./workshop-startup";
import { VERSION } from "./version";

interface ParsedUninstallArgs {
  wipe: boolean;
  yes: boolean;
  dryRun: boolean;
  registryFile: string | null;
}

export interface RunUninstallOptions {
  wipe?: boolean;
  dryRun?: boolean;
  registryFile?: string;
  homeDir?: string;
  cwd?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  runCommand?: WorkshopStartupDisableOptions["runCommand"];
  stopTimeoutMs?: number;
}

export interface RunUninstallResult {
  ok: boolean;
  dryRun: boolean;
  removed: string[];
  warnings: string[];
  failures: string[];
}

class UsageError extends Error {}

const INSTALLER_BLOCK_START = "# Added by Raindrop installer";
const INSTALLER_BLOCK_END = "# End Raindrop installer";

function parseArgs(argv: string[]): ParsedUninstallArgs {
  const out: ParsedUninstallArgs = {
    wipe: false,
    yes: false,
    dryRun: false,
    registryFile: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wipe") out.wipe = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--registry-file=")) out.registryFile = arg.slice("--registry-file=".length);
    else if (arg === "--registry-file") out.registryFile = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }

  return out;
}

function printHelp(): void {
  console.log(`raindrop uninstall ${VERSION} — remove Raindrop from this machine

USAGE
    raindrop uninstall [--wipe] [--yes] [--dry-run]

WHAT IT DOES
    Removes Raindrop skills, MCP entries, startup registration, PATH edits,
    and the installed binary. Local Workshop traces are preserved by default.

FLAGS
    --wipe       Also delete local Workshop DB, logs, bundles, and caches.
    -y, --yes    Skip confirmation prompts.
    --dry-run    Print what would be removed without modifying files.
`);
}

function stateDir(homeDir: string): string {
  return path.join(homeDir, ".raindrop");
}

function defaultRegistryFile(homeDir: string): string {
  return path.join(stateDir(homeDir), "install-registry.json");
}

function pidPath(homeDir: string): string {
  return path.join(stateDir(homeDir), "raindrop_workshop.pid");
}

function portPath(homeDir: string): string {
  return path.join(stateDir(homeDir), "raindrop_workshop.port");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(homeDir: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath(homeDir), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopWorkshopDaemon(opts: {
  homeDir: string;
  dryRun: boolean;
  removed: string[];
  failures: string[];
  timeoutMs: number;
}): Promise<void> {
  const pid = readPid(opts.homeDir);
  if (!pid) {
    removeFile(portPath(opts.homeDir), "stale workshop port file", opts);
    return;
  }

  if (opts.dryRun) {
    opts.removed.push(`would stop workshop daemon pid ${pid}`);
    return;
  }

  if (!processAlive(pid)) {
    removeFile(pidPath(opts.homeDir), "stale workshop pid file", opts);
    removeFile(portPath(opts.homeDir), "stale workshop port file", opts);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    opts.failures.push(`failed to signal workshop pid ${pid}: ${(err as Error).message}`);
    return;
  }

  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      removeFile(pidPath(opts.homeDir), "workshop pid file", opts);
      removeFile(portPath(opts.homeDir), "workshop port file", opts);
      opts.removed.push(`stopped workshop daemon pid ${pid}`);
      return;
    }
    await sleep(100);
  }
  opts.failures.push(`workshop pid ${pid} did not exit within ${opts.timeoutMs}ms`);
}

function removeFile(
  file: string,
  label: string,
  opts: { dryRun: boolean; removed: string[]; failures: string[] },
): void {
  if (opts.dryRun) {
    opts.removed.push(`would remove ${label}: ${file}`);
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

function removePath(
  target: string,
  label: string,
  opts: { dryRun: boolean; removed: string[]; failures: string[] },
): void {
  if (opts.dryRun) {
    opts.removed.push(`would remove ${label}: ${target}`);
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

function removeEmptyDir(target: string): void {
  try {
    fs.rmdirSync(target);
  } catch {
    // Directory missing or not empty; either is fine.
  }
}

function fallbackEntries(homeDir: string, cwd: string): InstallRegistryEntry[] {
  const now = new Date().toISOString();
  const entries: InstallRegistryEntry[] = [];
  const includeGlobal = path.resolve(homeDir) === path.resolve(os.homedir());
  const scopes = includeGlobal ? (["global", "local"] as const) : (["local"] as const);

  for (const scope of scopes) {
    const agents = getSupportedInstallAgents({ scope, cwd })
      .filter((agent) => agent.supportsSkills || agent.supportsMcp)
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

  // Ensure custom global Windsurf cleanup is considered even if support lists change.
  if (includeGlobal && !entries.some((entry) => entry.id === "global:windsurf")) {
    entries.push({
      id: "global:windsurf",
      agent: "windsurf",
      scope: "global",
      cwd: null,
      installer: "agent-install",
      raindropVersion: VERSION,
      installedAt: now,
      updatedAt: now,
    });
  }

  return entries;
}

function loadEntries(opts: {
  registryFile: string;
  homeDir: string;
  cwd: string;
  warnings: string[];
}): { entries: InstallRegistryEntry[]; registryLoaded: boolean } {
  try {
    const registry = loadInstallRegistry(opts.registryFile);
    if (registry.installs.length === 0) {
      opts.warnings.push("install registry is empty; falling back to best-effort cleanup");
      return { entries: fallbackEntries(opts.homeDir, opts.cwd), registryLoaded: false };
    }
    return { entries: registry.installs, registryLoaded: true };
  } catch (err) {
    opts.warnings.push(
      `could not read install registry at ${opts.registryFile}: ${(err as Error).message}; falling back to best-effort cleanup`,
    );
    return { entries: fallbackEntries(opts.homeDir, opts.cwd), registryLoaded: false };
  }
}

function removeSkillsForEntry(
  entry: InstallRegistryEntry,
  opts: { dryRun: boolean; removed: string[]; failures: string[] },
): void {
  if (!isSkillAgentType(entry.agent)) return;

  const isGlobal = entry.scope === "global";
  const cwd = entry.cwd ?? process.cwd();
  for (const skill of SKILLS) {
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

function removeMcpForEntry(
  entry: InstallRegistryEntry,
  homeDir: string,
  opts: { dryRun: boolean; removed: string[]; failures: string[] },
): void {
  const cwd = entry.cwd ?? process.cwd();

  if (opts.dryRun) {
    try {
      const owned = findOwnedMcpEntries({ agent: entry.agent, scope: entry.scope, cwd, homeDir });
      if (owned.length === 0) {
        opts.removed.push(`no ${entry.agent} MCP entry to remove (${entry.scope})`);
      }
      for (const o of owned) {
        opts.removed.push(`would remove ${entry.agent} MCP server '${o.serverName}' (${entry.scope}, matched by ${o.matchedBy})`);
      }
    } catch (err) {
      opts.failures.push(`failed to scan ${entry.agent} MCP config: ${(err as Error).message}`);
    }
    return;
  }

  try {
    const results = removeOwnedMcpEntries({ agent: entry.agent, scope: entry.scope, cwd, homeDir });
    for (const r of results) {
      if (r.error) {
        opts.failures.push(`failed to remove ${entry.agent} MCP '${r.entry.serverName}' from ${r.entry.path}: ${r.error}`);
      } else if (r.removed) {
        opts.removed.push(`removed ${entry.agent} MCP '${r.entry.serverName}' from ${r.entry.path}`);
      }
    }
  } catch (err) {
    opts.failures.push(`failed to scan ${entry.agent} MCP config: ${(err as Error).message}`);
  }
}

function removeStartup(opts: RunUninstallOptions & { removed: string[]; failures: string[] }): void {
  if (opts.dryRun) {
    opts.removed.push("would remove Workshop startup registration");
    return;
  }
  const result = disableWorkshopStartup({
    homeDir: opts.homeDir,
    platform: opts.platform,
    runCommand: opts.runCommand,
  });
  if (result.ok || result.skipped) {
    opts.removed.push(result.message + (result.file ? ` (${result.file})` : ""));
  } else {
    opts.failures.push(result.message + (result.file ? ` (${result.file})` : ""));
  }
}

function removeShellPathBlocks(
  homeDir: string,
  opts: { dryRun: boolean; removed: string[]; failures: string[] },
): void {
  const files = [
    path.join(homeDir, ".zshrc"),
    path.join(homeDir, ".bashrc"),
    path.join(homeDir, ".profile"),
    path.join(homeDir, ".config", "fish", "config.fish"),
  ];
  const block = new RegExp(
    `(?:^|\\n)${escapeRegExp(INSTALLER_BLOCK_START)}\\n[\\s\\S]*?\\n${escapeRegExp(INSTALLER_BLOCK_END)}\\n?`,
    "g",
  );

  for (const file of files) {
    let original: string;
    try {
      original = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!block.test(original)) continue;
    block.lastIndex = 0;
    if (opts.dryRun) {
      opts.removed.push(`would remove shell PATH block from ${file}`);
      continue;
    }
    const updated = original.replace(block, (match) => (match.startsWith("\n") ? "\n" : ""));
    try {
      fs.writeFileSync(file, updated);
      opts.removed.push(`removed shell PATH block from ${file}`);
    } catch (err) {
      opts.failures.push(`failed to update ${file}: ${(err as Error).message}`);
    }
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wipeState(
  homeDir: string,
  opts: { dryRun: boolean; removed: string[]; failures: string[] },
): void {
  const root = stateDir(homeDir);
  const db = path.join(root, "raindrop_workshop.db");
  const targets = [
    db,
    `${db}-wal`,
    `${db}-shm`,
    path.join(root, "raindrop_workshop.log"),
    path.join(root, "raindrop_workshop.startup.log"),
    pidPath(homeDir),
    portPath(homeDir),
    path.join(root, "bundles"),
    path.join(root, "migrations"),
    path.join(root, "updates"),
    path.join(root, "agents.json"),
    path.join(root, "replay-projects.json"),
    path.join(root, "active-workspace.json"),
  ];

  for (const target of targets) removePath(target, "Raindrop state", opts);

  // Replay command logs use the project basename in the filename, so glob.
  try {
    for (const entry of fs.readdirSync(root)) {
      if (/^replay-.*\.log$/.test(entry)) {
        removePath(path.join(root, entry), "Raindrop state", opts);
      }
    }
  } catch {
    // State dir doesn't exist; nothing to scan.
  }
}

function isSafeBinaryPath(execPath: string, homeDir: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  if (base !== "raindrop" && base !== "raindrop.exe") return false;
  if (execPath.includes(`${path.sep}Cellar${path.sep}`)) return false;
  const expected = path.join(homeDir, ".raindrop", "bin", path.basename(execPath));
  return path.resolve(execPath) === path.resolve(expected);
}

function removeBinary(
  execPath: string,
  homeDir: string,
  opts: { dryRun: boolean; removed: string[]; failures: string[]; warnings: string[] },
): void {
  if (!isSafeBinaryPath(execPath, homeDir)) {
    opts.warnings.push(`skipped binary removal for non-standard path: ${execPath}`);
    return;
  }
  removeFile(execPath, "raindrop binary", opts);
  removeFile(`${execPath}.prev`, "previous raindrop binary", opts);
}

function cleanupEmptyStateDirs(homeDir: string): void {
  removeEmptyDir(path.join(homeDir, ".raindrop", "bin"));
  removeEmptyDir(path.join(homeDir, ".raindrop"));
}

export async function runUninstall(opts: RunUninstallOptions = {}): Promise<RunUninstallResult> {
  const homeDir = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const registryFile = opts.registryFile ?? defaultRegistryFile(homeDir);
  const dryRun = Boolean(opts.dryRun);
  const wipe = Boolean(opts.wipe);
  const removed: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  await stopWorkshopDaemon({
    homeDir,
    dryRun,
    removed,
    failures,
    timeoutMs: opts.stopTimeoutMs ?? 5_000,
  });
  const daemonStopFailed = failures.length > 0;

  removeStartup({ ...opts, homeDir, dryRun, removed, failures });

  const { entries, registryLoaded } = loadEntries({ registryFile, homeDir, cwd, warnings });
  for (const entry of entries) {
    removeMcpForEntry(entry, homeDir, { dryRun, removed, failures });
    removeSkillsForEntry(entry, { dryRun, removed, failures });
  }

  if (failures.length === 0 && registryLoaded) {
    removeFile(registryFile, "install registry", { dryRun, removed, failures });
  } else if (registryLoaded) {
    warnings.push(`kept install registry for retry because cleanup had failures: ${registryFile}`);
  }

  removeShellPathBlocks(homeDir, { dryRun, removed, failures });

  if (wipe && !daemonStopFailed) {
    wipeState(homeDir, { dryRun, removed, failures });
  } else if (wipe) {
    warnings.push("skipped local state wipe because the Workshop daemon could not be stopped");
  }

  removeBinary(opts.execPath ?? process.execPath, homeDir, { dryRun, removed, warnings, failures });

  if (!dryRun) cleanupEmptyStateDirs(homeDir);

  return { ok: failures.length === 0, dryRun, removed, warnings, failures };
}

async function confirmUninstall(wipe: boolean): Promise<boolean> {
  const detail = wipe
    ? "This will remove Raindrop integrations, the binary, and local Workshop data."
    : "This will remove Raindrop integrations and the binary. Local Workshop data will be preserved.";
  console.error(detail);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Type "Y" to continue: ');
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function printResult(result: RunUninstallResult): void {
  for (const warning of result.warnings) console.warn(`[uninstall] warning: ${warning}`);
  for (const item of result.removed) console.log(`[uninstall] ${item}`);
  for (const failure of result.failures) console.error(`[uninstall] ${failure}`);
  if (result.dryRun) {
    console.log("[uninstall] dry run complete; no changes made.");
  } else if (result.ok) {
    console.log("[uninstall] complete.");
    console.log("[uninstall] restart your shell to drop any in-memory PATH changes.");
  }
}

export async function cmdUninstall(argv: string[]): Promise<number> {
  let args: ParsedUninstallArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      console.error("run `raindrop uninstall --help` for usage.");
      return 64;
    }
    throw err;
  }

  if (!args.yes && !args.dryRun) {
    const ok = await confirmUninstall(args.wipe);
    if (!ok) {
      console.error("uninstall cancelled");
      return 1;
    }
  }

  const result = await runUninstall({
    wipe: args.wipe,
    dryRun: args.dryRun,
    registryFile: args.registryFile ?? undefined,
  });
  printResult(result);
  return result.ok ? 0 : 1;
}

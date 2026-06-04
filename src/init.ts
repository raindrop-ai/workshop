import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import tty from "node:tty";
import { fileURLToPath } from "node:url";
import { applyInstallPlan, mcpCleanupWarnings } from "./install/apply";
import { getSupportedInstallAgents } from "./install/detect";
import { buildInstallPlan } from "./install/plan";
import { runInstallWizard } from "./install/wizard";
import { offerCloudInstrumentation } from "./cloud/offer";
import type { InstallAgentId, InstallScope } from "./install/types";
import { enableWorkshopStartup, type WorkshopStartupCommand } from "./workshop-startup";
import { VERSION } from "./version";

interface ParsedArgs {
  scope: InstallScope | null;
  cwd: string;
  binPath: string | null;
  registryFile: string | null;
  bundleRoot: string | null;
  explicit: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    scope: null,
    cwd: process.cwd(),
    binPath: null,
    registryFile: null,
    bundleRoot: null,
    explicit: argv.length > 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--global") out.scope = "global";
    else if (arg === "--local") out.scope = "local";
    else if (arg.startsWith("--scope=")) out.scope = parseScope(arg.slice("--scope=".length));
    else if (arg === "--scope") out.scope = parseScope(argv[++i] ?? "");
    else if (arg.startsWith("--cwd=")) out.cwd = path.resolve(arg.slice("--cwd=".length));
    else if (arg === "--cwd") out.cwd = path.resolve(argv[++i] ?? process.cwd());
    else if (arg.startsWith("--bin-path=")) out.binPath = arg.slice("--bin-path=".length);
    else if (arg === "--bin-path") out.binPath = argv[++i] ?? null;
    else if (arg.startsWith("--registry-file=")) out.registryFile = arg.slice("--registry-file=".length);
    else if (arg === "--registry-file") out.registryFile = argv[++i] ?? null;
    else if (arg.startsWith("--bundle-root=")) out.bundleRoot = arg.slice("--bundle-root=".length);
    else if (arg === "--bundle-root") out.bundleRoot = argv[++i] ?? null;
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }

  return out;
}

function parseScope(input: string): InstallScope {
  if (input === "global" || input === "local") return input;
  throw new UsageError(`--scope must be 'global' or 'local', got '${input}'`);
}

function hasInteractiveStdin(): boolean {
  return Boolean((process.stdin as { isTTY?: boolean }).isTTY);
}

function openTtyInput(): tty.ReadStream | null {
  if (process.env.RAINDROP_SETUP_TTY !== "1") return null;
  try {
    return new tty.ReadStream(fs.openSync("/dev/tty", "r+"));
  } catch {
    return null;
  }
}

function printHelp(): void {
  console.log(`raindrop setup ${VERSION} — set up Raindrop in AI coding agents

USAGE
    raindrop setup
    raindrop setup --global
    raindrop setup --local

WHAT IT INSTALLS
    Raindrop commands/skills and the Raindrop MCP server. These are installed
    together; there is no partial setup mode.

FLAGS
    --global          Install for every project on this machine (default)
    --local           Install only for --cwd / current project
    --scope=<scope>   global | local
    --cwd=<dir>       Project directory for local installs (default: cwd)
    --bin-path=<p>    Override raindrop binary path used by MCP entries

RAINDROP CLOUD
    When run interactively, setup also offers to instrument Raindrop Cloud
    (hosted monitoring at app.raindrop.ai). It is optional; decline to stay
    Workshop-only, or run \`raindrop cloud setup\` later.
`);
}

function setupAgents(scope: InstallScope, cwd: string): InstallAgentId[] {
  return getSupportedInstallAgents({ scope, cwd })
    .filter((agent) => agent.supportsSkills && agent.supportsMcp)
    .map((agent) => agent.agent);
}

function summarizeInstall(): string {
  return [
    "Next steps:",
    "  Run /instrument-agent inside your AI coding agent.",
    "",
  ].join("\n");
}

function shouldStartWorkshop(args: ParsedArgs): boolean {
  return !process.env.RAINDROP_SKIP_WORKSHOP_START && !args.registryFile && !args.bundleRoot;
}

function shouldConfigureStartup(args: ParsedArgs): boolean {
  return !process.env.RAINDROP_SKIP_STARTUP && !args.registryFile && !args.bundleRoot;
}

function workshopCommand(args: string[]): WorkshopStartupCommand {
  const isCompiled = path.basename(process.execPath).toLowerCase().startsWith("raindrop");
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  return isCompiled
    ? { program: process.execPath, args }
    : { program: process.execPath, args: [entry, ...args] };
}

function configureStartup(args: ParsedArgs): void {
  if (!shouldConfigureStartup(args)) return;
  if (!path.basename(process.execPath).toLowerCase().startsWith("raindrop")) return;
  try {
    const result = enableWorkshopStartup({ command: workshopCommand(["workshop", "serve"]) });
    if (!result.ok) console.warn(`setup: ${result.message}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`setup: failed to configure Workshop startup: ${message}`);
  }
}

function openWorkshop(): number {
  const command = workshopCommand(["workshop"]);
  const result = spawnSync(
    command.program,
    command.args,
    { env: process.env, stdio: "inherit" },
  );
  if ((result.status ?? 1) === 0) return 0;
  console.error("setup: failed to open Raindrop Workshop.");
  return result.status ?? 1;
}

function installSucceeded(result: Awaited<ReturnType<typeof applyInstallPlan>>): boolean {
  return result.items.every((item) => item.skillsFailed.length === 0 && item.mcp.success);
}

function warnMcpCleanupFailures(result: Awaited<ReturnType<typeof applyInstallPlan>>): void {
  for (const item of result.items) {
    for (const msg of mcpCleanupWarnings(item)) {
      console.warn(`setup: ${msg}`);
    }
  }
}

function finishSetup(args: ParsedArgs, result: Awaited<ReturnType<typeof applyInstallPlan>>): number {
  warnMcpCleanupFailures(result);
  const success = installSucceeded(result);
  if (success && shouldStartWorkshop(args)) {
    configureStartup(args);
    const startCode = openWorkshop();
    if (startCode !== 0) return startCode;
  }
  process.stdout.write(summarizeInstall());
  return success ? 0 : 1;
}

/** Offer cloud only when we have an interactive stream to prompt on and we're
 * not in a registry/bundle-targeted test install (those run headless). */
function canOfferCloud(args: ParsedArgs, interactive: boolean): boolean {
  return interactive && !args.registryFile && !args.bundleRoot;
}

export async function cmdSetup(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      console.error("run `raindrop setup --help` for usage.");
      return 64;
    }
    throw err;
  }

  // Acquire an interactive input stream once: a real TTY stdin, or /dev/tty
  // when the installer pipes us through bash (RAINDROP_SETUP_TTY=1).
  const ttyInput = hasInteractiveStdin() ? null : openTtyInput();
  const interactive = hasInteractiveStdin() || Boolean(ttyInput);

  try {
    if (!args.explicit && interactive) {
      const { plan, skipped, scope } = await runInstallWizard({ cwd: args.cwd, input: ttyInput ?? undefined });
      if (skipped) return 0;
      const result = await applyInstallPlan(plan, {
        binPath: args.binPath ?? undefined,
        registryFile: args.registryFile ?? undefined,
        bundleRoot: args.bundleRoot ?? undefined,
      });
      const code = finishSetup(args, result);
      // Only offer cloud once the local setup fully succeeded. `code === 0`
      // implies the agent install succeeded AND Workshop opened cleanly, so we
      // never prompt (or override the exit code) after a partial failure.
      if (code === 0 && canOfferCloud(args, interactive)) {
        await offerCloudInstrumentation({ scope, cwd: args.cwd, input: ttyInput ?? undefined });
      }
      return code;
    }

    const scope = args.scope ?? "global";
    const agents = setupAgents(scope, args.cwd);
    if (agents.length === 0) {
      console.error("setup: no approved coding agents support both skills and MCP for this scope.");
      return 64;
    }

    const plan = buildInstallPlan({ agents, scope, cwd: args.cwd });
    const result = await applyInstallPlan(plan, {
      binPath: args.binPath ?? undefined,
      registryFile: args.registryFile ?? undefined,
      bundleRoot: args.bundleRoot ?? undefined,
    });
    const code = finishSetup(args, result);
    if (code === 0 && canOfferCloud(args, interactive)) {
      await offerCloudInstrumentation({ scope, cwd: args.cwd, input: ttyInput ?? undefined });
    }
    return code;
  } finally {
    ttyInput?.destroy();
  }
}

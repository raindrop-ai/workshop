import { applyInstallPlan, mcpCleanupWarnings } from "./apply";
import { loadInstallRegistry } from "./registry";
import type { InstallPlan } from "./types";

interface SyncOptions {
  registryFile?: string;
  binPath?: string;
}

interface SyncResult {
  total: number;
  synced: number;
  failed: string[];
  cleanupWarnings: string[];
}

async function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const registry = loadInstallRegistry(opts.registryFile);
  const plan: InstallPlan = {
    items: registry.installs.map((entry) => ({
      agent: entry.agent,
      scope: entry.scope,
      cwd: entry.cwd,
      label: entry.agent,
    })),
  };

  if (plan.items.length === 0) return { total: 0, synced: 0, failed: [], cleanupWarnings: [] };

  const result = await applyInstallPlan(plan, {
    registryFile: opts.registryFile,
    binPath: opts.binPath,
  });
  const failed = result.items
    .filter((item) => item.skillsFailed.length > 0 || !item.mcp.success)
    .map((item) => item.agent);
  const cleanupWarnings = result.items.flatMap(mcpCleanupWarnings);

  return {
    total: plan.items.length,
    synced: plan.items.length - failed.length,
    failed,
    cleanupWarnings,
  };
}

function summarizeSync(result: SyncResult): string {
  if (result.total === 0) return "No tracked installs to refresh. Run `raindrop setup` first.";
  const lines = [`Refreshed ${result.synced}/${result.total} tracked Raindrop install${result.total === 1 ? "" : "s"}.`];
  if (result.failed.length > 0) {
    lines.push(`Failed: ${result.failed.join(", ")}`);
  }
  for (const warning of result.cleanupWarnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}

export async function cmdSync(argv: string[]): Promise<number> {
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(`raindrop sync — refresh tracked Raindrop agent installs

USAGE
    raindrop sync

WHAT IT DOES
    Reads ~/.raindrop/install-registry.json and reinstalls Raindrop commands
    plus the Raindrop MCP server for every tracked agent/scope.
`);
      return 0;
    }
    console.error(`sync: unknown arg: ${arg}`);
    console.error("run `raindrop sync --help` for usage.");
    return 64;
  }

  const result = await runSync();
  process.stdout.write(summarizeSync(result) + "\n");
  return result.failed.length === 0 ? 0 : 1;
}

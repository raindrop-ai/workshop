import path from "node:path";

import { APP_ORIGIN } from "../auth/constants";
import { ensureLoggedIn } from "../auth/login";
import { getSupportedInstallAgents } from "../install/detect";
import { buildInstallPlan } from "../install/plan";
import type { InstallAgentId, InstallScope } from "../install/types";
import { VERSION } from "../version";
import { applyCloudInstallPlan, type ApplyCloudInstallResult } from "./apply";
import { writeWriteKeyToEnv, type WriteEnvResult } from "./env-file";
import { cmdCloudUninstall } from "./uninstall";

class UsageError extends Error {}

interface ParsedArgs {
  scope: InstallScope;
  cwd: string;
  serverUrl: string | null;
  apiKey: string | null;
  skillsRef: string | null;
  registryFile: string | null;
}

/** Reject an explicitly empty `--flag=` value (a usage error rather than a
 * silent fallback, so e.g. `--server-url=` / `--skills-ref=` never quietly use
 * an empty URL or the default ref). The `=` form is unambiguous, so a leading
 * "-" is allowed — e.g. an API key that happens to start with a hyphen. */
function requireValue(flag: string, value: string): string {
  if (value === "") {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

/** Read the value following a space-separated flag, rejecting a missing/empty
 * value or one that is actually the next flag. To pass a value beginning with
 * "-", use the unambiguous `--flag=value` form. */
function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parseScope(input: string): InstallScope {
  if (input === "global" || input === "local") return input;
  throw new UsageError(`--scope must be 'global' or 'local', got '${input}'`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    scope: "global",
    cwd: process.cwd(),
    serverUrl: null,
    apiKey: null,
    skillsRef: null,
    registryFile: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--global") out.scope = "global";
    else if (arg === "--local") out.scope = "local";
    else if (arg.startsWith("--scope=")) out.scope = parseScope(arg.slice("--scope=".length));
    else if (arg === "--scope") out.scope = parseScope(takeValue(argv, i++, arg));
    else if (arg.startsWith("--cwd=")) out.cwd = path.resolve(requireValue("--cwd", arg.slice("--cwd=".length)));
    else if (arg === "--cwd") out.cwd = path.resolve(takeValue(argv, i++, arg));
    else if (arg.startsWith("--server-url=")) out.serverUrl = requireValue("--server-url", arg.slice("--server-url=".length));
    else if (arg === "--server-url") out.serverUrl = takeValue(argv, i++, arg);
    else if (arg.startsWith("--api-key=")) out.apiKey = requireValue("--api-key", arg.slice("--api-key=".length));
    else if (arg === "--api-key") out.apiKey = takeValue(argv, i++, arg);
    else if (arg.startsWith("--skills-ref=")) out.skillsRef = requireValue("--skills-ref", arg.slice("--skills-ref=".length));
    else if (arg === "--skills-ref") out.skillsRef = takeValue(argv, i++, arg);
    else if (arg.startsWith("--registry-file=")) out.registryFile = requireValue("--registry-file", arg.slice("--registry-file=".length));
    else if (arg === "--registry-file") out.registryFile = takeValue(argv, i++, arg);
    else if (arg === "-h" || arg === "--help") {
      printCloudSetupHelp();
      process.exit(0);
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }

  return out;
}

function printCloudSetupHelp(): void {
  console.log(`raindrop cloud setup ${VERSION} — connect this project to Raindrop cloud

USAGE
    raindrop cloud setup [flags]

WHAT IT DOES
    1. Signs you in to Raindrop (reusing an existing session when possible).
    2. Writes your org write key to ./.env (RAINDROP_WRITE_KEY).
    3. Installs the Raindrop cloud skills + hosted MCP server into your AI
       coding agents. No local daemon is started.

FLAGS
    --global            Install for every project on this machine (default)
    --local             Install only for --cwd / current project
    --scope=<scope>     global | local
    --cwd=<dir>         Project directory (default: current directory)
    --api-key=<key>     Authenticate non-interactively with an org API key
                        (or set RAINDROP_API_KEY). Skips the browser.
    --server-url=<url>  Override the hosted MCP endpoint (advanced / staging).
    --skills-ref=<ref>  Pin the cloud skills to a git ref (default: main).
`);
}

function cloudSetupAgents(scope: InstallScope, cwd: string): InstallAgentId[] {
  return getSupportedInstallAgents({ scope, cwd })
    .filter((agent) => agent.supportsSkills && agent.supportsMcp)
    .map((agent) => agent.agent);
}

export function installSucceeded(result: ApplyCloudInstallResult): boolean {
  return result.items.every((item) => item.skillsFailed.length === 0 && item.mcp.success);
}

/** Render an absolute env path relative to the user's cwd for display, e.g.
 * `./.env` or `subdir/.env`, falling back to the absolute path when it lies
 * outside cwd. */
export function formatEnvPath(envPath: string): string {
  const rel = path.relative(process.cwd(), envPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return envPath;
  return `./${rel}`;
}

/** Build the notice shown when the agent install aborts after the write key was
 * already written: where the key landed, plus the gitignore warning so a secret
 * in a non-gitignored .env is never left unmentioned. Exported for tests. */
export function buildWriteKeyPersistedNotice(env: WriteEnvResult): string[] {
  const envPath = formatEnvPath(env.envPath);
  const lines = [`  Write key was written to ${envPath} (RAINDROP_WRITE_KEY).`];
  if (!env.gitignored) {
    lines.push(
      `  \x1b[33m! ${envPath} is not gitignored — add it to .gitignore so the key isn't committed.\x1b[0m`,
    );
  }
  return lines;
}

/** Build the user-facing summary lines (also exported for tests). */
export function buildSummaryLines(
  result: ApplyCloudInstallResult,
  envGitignored: boolean,
  succeeded: boolean,
  envPath: string,
): string[] {
  const agents = result.items.map((item) => item.agent).join(", ");
  const lines = [
    "",
    succeeded
      ? "\x1b[32m✓\x1b[0m Raindrop cloud is set up."
      : "\x1b[33m!\x1b[0m Raindrop cloud setup finished with errors.",
  ];
  if (agents) lines.push(`  Agents:    ${agents}`);
  lines.push(`  Write key: written to ${envPath} (RAINDROP_WRITE_KEY)`);
  if (!envGitignored) {
    lines.push(
      `  \x1b[33m! ${envPath} is not gitignored — add it to .gitignore so the key isn't committed.\x1b[0m`,
    );
  }

  // Surface exactly what failed so a partial install is actionable, not hidden
  // behind a success banner.
  for (const item of result.items) {
    for (const failed of item.skillsFailed) {
      lines.push(`  \x1b[31m✗\x1b[0m ${item.agent}: skill '${failed.skill}' failed — ${failed.error}`);
    }
    if (!item.mcp.success) {
      lines.push(`  \x1b[31m✗\x1b[0m ${item.agent}: MCP install failed — ${item.mcp.error ?? "unknown error"}`);
    }
  }

  if (succeeded) {
    lines.push(
      "",
      "Next steps:",
      "  Run /raindrop-setup inside your AI coding agent to instrument your app.",
      `  Then watch events arrive at ${APP_ORIGIN}.`,
    );
  } else {
    lines.push("", "Re-run `raindrop cloud setup` to retry the failed agents.");
  }
  lines.push("");
  return lines;
}

function summarize(
  result: ApplyCloudInstallResult,
  envGitignored: boolean,
  succeeded: boolean,
  envPath: string,
): void {
  process.stdout.write(buildSummaryLines(result, envGitignored, succeeded, envPath).join("\n"));
}

export async function cmdCloudSetup(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      console.error("run `raindrop cloud setup --help` for usage.");
      return 64;
    }
    throw err;
  }

  const agents = cloudSetupAgents(args.scope, args.cwd);
  if (agents.length === 0) {
    console.error("cloud setup: no approved coding agents support both skills and MCP for this scope.");
    return 64;
  }

  // Sign in if needed (reuses a valid stored session without a browser) and
  // fetch the org write key. This is the only command the user needs to run.
  let writeKey: string;
  try {
    const login = await ensureLoggedIn({
      serverUrl: args.serverUrl ?? undefined,
      apiKey: args.apiKey ?? undefined,
    });
    writeKey = login.writeKey;
    console.log(
      login.reused
        ? "\x1b[32m✓\x1b[0m Using your existing Raindrop sign-in."
        : "\x1b[32m✓\x1b[0m Signed in to Raindrop.",
    );
  } catch (err) {
    console.error(`cloud setup: sign-in failed: ${(err as Error).message}`);
    return 1;
  }

  let env: WriteEnvResult;
  try {
    env = writeWriteKeyToEnv({ cwd: args.cwd, key: writeKey });
  } catch (err) {
    console.error(`cloud setup: ${(err as Error).message}`);
    return 1;
  }

  let result: ApplyCloudInstallResult;
  try {
    result = await applyCloudInstallPlan(buildInstallPlan({ agents, scope: args.scope, cwd: args.cwd }), {
      serverUrl: args.serverUrl ?? undefined,
      registryFile: args.registryFile ?? undefined,
      skills: args.skillsRef ? { ref: args.skillsRef } : undefined,
    });
  } catch (err) {
    console.error(`cloud setup: ${(err as Error).message}`);
    // The write key is already persisted at this point, so tell the user where
    // it landed (and warn if .env isn't gitignored) rather than leaving a secret
    // on disk unmentioned just because the agent install aborted.
    for (const line of buildWriteKeyPersistedNotice(env)) console.error(line);
    return 1;
  }

  const succeeded = installSucceeded(result);
  summarize(result, env.gitignored, succeeded, formatEnvPath(env.envPath));
  return succeeded ? 0 : 1;
}

export async function dispatchCloud(verb: string | undefined, rest: string[]): Promise<number> {
  switch (verb) {
    case "setup":
      return cmdCloudSetup(rest);
    case "uninstall":
      return cmdCloudUninstall(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printCloudHelp();
      return 0;
    default:
      console.error(`unknown subcommand: cloud ${verb}`);
      console.error("run `raindrop cloud --help` for usage.");
      return 64;
  }
}

function printCloudHelp(): void {
  console.log(`raindrop cloud — connect projects to Raindrop cloud

USAGE
    raindrop cloud setup [flags]

COMMANDS
    setup        Sign in, write the write key to ./.env, and install the cloud
                 skills + hosted MCP into your AI coding agents (no daemon).
    uninstall    Remove the cloud skills + hosted MCP from your agents.

Run \`raindrop cloud setup --help\` or \`raindrop cloud uninstall --help\` for flags.
`);
}

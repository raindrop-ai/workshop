#!/usr/bin/env node
/**
 * raindrop CLI entry.
 *
 * Top-level: `raindrop` is an umbrella for raindrop tooling. Today the only
 * product underneath is `workshop` (the local trace debugger). Future
 * products plug in as siblings: `raindrop foo …`.
 *
 *   raindrop                         help
 *   raindrop --version | -v          print version
 *   raindrop setup [flags]           wire raindrop into supported agents
 *                                     (drops MCP + skill files; see setup --help)
 *   raindrop sync                    refresh skills/MCP in every place we
 *                                     wired them up (per ~/.raindrop/install-registry.json)
 *   raindrop update [flags]          umbrella update (currently == workshop update);
 *                                     auto-runs `raindrop sync` at the end
 *   raindrop uninstall [flags]       remove raindrop integrations + binary
 *   raindrop replay register         register current project replay config
 *   raindrop workshop                start daemon + open UI (idempotent)
 *   raindrop workshop setup          write RAINDROP_LOCAL_DEBUGGER to ./.env, then start+open
 *   raindrop workshop start          start daemon in background
 *   raindrop workshop stop           stop daemon
 *   raindrop workshop reset          delete local Workshop DB after confirmation
 *   raindrop workshop status         is it running?
 *   raindrop workshop serve          foreground daemon
 *   raindrop workshop update [args]  product-scoped update
 *   raindrop workshop mcp            MCP server over stdio (used by Claude Code/Cursor)
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createInterface } from "readline/promises";
import { createServer } from "./server";
import { WORKSHOP_BIND_HOST } from "./local-access";
import { closeDb, getDbPath } from "./db";
import { findFreePort, isPortFree } from "./port-check";
import { VERSION } from "./version";
import { runUpdate } from "./update";
import { cmdSetup } from "./init";
import { cmdSync } from "./install/sync";
import { cmdUninstall } from "./uninstall";
import { stopWorkshopStartup } from "./workshop-startup";
import { registerReplayProject } from "./agents-config";

// Umbrella state dir is `~/.raindrop/`. Workshop-specific state lives at
// the top of it for now (single product); we'd nest further if/when a
// second product lands.

const STATE_DIR = path.join(os.homedir(), ".raindrop");
const PID_PATH = path.join(STATE_DIR, "raindrop_workshop.pid");
const PORT_PATH = path.join(STATE_DIR, "raindrop_workshop.port");
const LOG_PATH = path.join(STATE_DIR, "raindrop_workshop.log");
const DEFAULT_PORT = 5899;
const MAX_PORT = 65535;
const PORT_ENV = "RAINDROP_WORKSHOP_PORT";

function printWorkshopAccess(port: number, opts: { pid?: number | null; logs?: boolean } = {}): void {
  console.log("");
  console.log(`\x1b[36mRaindrop Workshop:\x1b[0m \x1b[4mhttp://localhost:${port}\x1b[0m`);
  if (opts.pid) console.log("\x1b[2mStop: raindrop workshop stop\x1b[0m");
  if (opts.logs) console.log("\x1b[2mLogs: " + LOG_PATH + "\x1b[0m");
  console.log("");
  console.log("env");
  console.log("  \x1b[2mRAINDROP_LOCAL_DEBUGGER=http://localhost:" + port + "/v1/\x1b[0m");
  console.log("");
}

function printPortFallback(requestedPort: number, port: number): void {
  if (port !== requestedPort) {
    console.log(`requested :${requestedPort}; using :${port}`);
  }
}

async function runBackend(): Promise<void> {
  const requestedPort = getConfiguredPort();
  const port = hasExplicitPort() ? requestedPort : await findFreePort(requestedPort);
  const { server } = await createServer(port);

  server.listen(port, WORKSHOP_BIND_HOST, () => {
    printPortFallback(requestedPort, port);
    printWorkshopAccess(port);
  });

  const shutdown = () => { server.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGUSR2", shutdown); // nodemon/tsx watch sends SIGUSR2

  // Block forever. Caller (`process.exit(await dispatchWorkshop(...))`) would
  // otherwise kill us the moment server.listen schedules its callback.
  await new Promise<void>(() => {});
}

async function runMcp(): Promise<void> {
  // The MCP server is a thin WebSocket bridge to the workshop daemon. If the
  // daemon isn't already running, the bridge would crash on `backend.connect()`
  // with no clear signal to the user (Claude Code surfaces the failure as
  // "Failed to reconnect"). Auto-start the daemon so the plugin is robust to
  // machine restarts. All progress goes to stderr — stdout is reserved for
  // JSON-RPC frames.
  if (!process.env.RAINDROP_WORKSHOP_URL) {
    try {
      const result = await ensureDaemonRunning();
      process.env.RAINDROP_WORKSHOP_URL = `http://localhost:${result.port}`;
      if (!result.alreadyRunning) {
        console.error(
          `[raindrop workshop mcp] auto-started daemon on :${result.port}` +
            (result.pid ? ` (pid ${result.pid})` : "") +
            ` — logs at ${LOG_PATH}`
        );
      }
    } catch (err) {
      console.error(`[raindrop workshop mcp] failed to ensure daemon: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const { runMcpServer } = await import("./mcp");
  const handle = await runMcpServer();
  const shutdown = async () => { await handle.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGUSR2", shutdown);

  // Block forever; stdio transport stays alive on its own, but we must not
  // let the dispatch chain return into `process.exit(0)`.
  await new Promise<void>(() => {});
}

interface EnsureDaemonResult {
  alreadyRunning: boolean;
  pid: number | null;
  requestedPort: number;
  port: number;
}

interface WorkshopPortSelection {
  alreadyRunning: boolean;
  port: number;
}

async function ensureDaemonRunning(): Promise<EnsureDaemonResult> {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const requestedPort = getConfiguredPort();
  const selection = hasExplicitPort()
    ? await selectExactWorkshopPort(requestedPort)
    : await selectWorkshopPort(requestedPort);
  const port = selection.port;

  if (selection.alreadyRunning) {
    try { fs.writeFileSync(PORT_PATH, String(port)); } catch {}
    return { alreadyRunning: true, pid: readPid(), requestedPort, port };
  }

  const stale = readPid();
  if (stale && !processAlive(stale)) {
    try { fs.unlinkSync(PID_PATH); } catch {}
    try { fs.unlinkSync(PORT_PATH); } catch {}
  }

  const logFd = fs.openSync(LOG_PATH, "a");
  // Two daemonization paths, one binary:
  //   - Compiled binary: process.execPath is the `raindrop` binary itself.
  //     We re-exec ourselves with `workshop serve`. We do NOT pass __filename
  //     — in a Bun-compiled binary, __filename resolves to the *build-time*
  //     source path (e.g. /Users/runner/work/.../src/index.ts), which is
  //     meaningless to the running binary and would be interpreted as an
  //     unknown subcommand argv[2].
  //   - Source mode (`bun src/index.ts workshop start`): process.execPath is
  //     the bun interpreter, which needs the source file as argv[1] before
  //     our subcommand. __filename here is a real, on-disk path.
  const isCompiled = path
    .basename(process.execPath)
    .toLowerCase()
    .startsWith("raindrop");
  const childArgs = isCompiled
    ? ["workshop", "serve"]
    : [__filename, "workshop", "serve"];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, [PORT_ENV]: String(port) },
  });
  fs.writeFileSync(PID_PATH, String(child.pid));
  fs.writeFileSync(PORT_PATH, String(port));
  child.unref();

  // 30s — cold-start sqlite migration replay + bun import on a loaded CI
  // worker can run for several seconds before /health responds.
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    if (await isHealthy(port)) {
      return { alreadyRunning: false, pid: child.pid ?? null, requestedPort, port };
    }
  }
  throw new Error(
    `workshop did not respond on :${port} within 30s — tail ${LOG_PATH} for details`
  );
}

async function cmdStart(): Promise<number> {
  try {
    const result = await ensureDaemonRunning();
    printPortFallback(result.requestedPort, result.port);
    printWorkshopAccess(result.port, { pid: result.pid, logs: !result.alreadyRunning || Boolean(result.pid) });
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

async function cmdStop(portHint?: number): Promise<number> {
  let pid = readPid();
  if (!pid) {
    const port = portHint ?? readPort();
    const health = port ? await getWorkshopHealth(port) : null;
    if (typeof health?.pid === "number" && processAlive(health.pid)) {
      pid = health.pid;
    }
  }
  if (!pid) {
    const startup = stopWorkshopStartup();
    console.log(startup.ok && !startup.skipped ? startup.message : "workshop not running (no pid file)");
    try { fs.unlinkSync(PORT_PATH); } catch {}
    return 0;
  }
  if (!processAlive(pid)) {
    console.log(`workshop not running (stale pid ${pid}); cleaning up`);
    try { fs.unlinkSync(PID_PATH); } catch {}
    try { fs.unlinkSync(PORT_PATH); } catch {}
    const startup = stopWorkshopStartup();
    if (startup.ok && !startup.skipped) console.log(startup.message);
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`failed to signal pid ${pid}:`, (err as Error).message);
    return 1;
  }
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!processAlive(pid)) {
      try { fs.unlinkSync(PID_PATH); } catch {}
      try { fs.unlinkSync(PORT_PATH); } catch {}
      const startup = stopWorkshopStartup();
      if (startup.ok && !startup.skipped) console.log(startup.message);
      console.log(`workshop stopped (pid ${pid})`);
      return 0;
    }
  }
  console.error(`pid ${pid} did not exit within 5s`);
  return 1;
}

async function cmdReset(args: string[]): Promise<number> {
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(`raindrop workshop reset — reset the local Workshop DB

USAGE
    raindrop workshop reset

This deletes local Workshop traces and saved data after confirmation.
`);
      return 0;
    } else {
      console.error(`unknown flag: ${arg}`);
      return 64;
    }
  }

  let selection: WorkshopPortSelection;
  try {
    selection = await selectConfiguredWorkshopPort();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  if (selection.alreadyRunning) {
    console.error(`workshop is running on :${selection.port}, stopping it first…`);
    const stopCode = await cmdStop(selection.port);
    if (stopCode !== 0) {
      console.error("failed to stop workshop; aborting reset");
      return stopCode;
    }
    if (await isHealthy(selection.port)) {
      console.error(`workshop is still running on :${selection.port}; aborting reset`);
      return 1;
    }
  }

  const dbPath = getDbPath();
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const existing = targets.filter((target) => fs.existsSync(target));

  console.error("This will permanently delete the local Raindrop Workshop database.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Type "Y" to continue: ');
    if (answer.trim().toLowerCase() !== "y") {
      console.error("reset cancelled");
      return 1;
    }
  } finally {
    rl.close();
  }

  closeDb();
  for (const target of existing) {
    fs.rmSync(target, { force: true });
  }
  if (existing.length === 0) {
    console.log("Reset successfully.");
  } else {
    console.log("Reset successfully.");
  }
  return 0;
}

async function cmdStatus(): Promise<number> {
  const pid = readPid();
  const requestedPort = getConfiguredPort();
  let selection: WorkshopPortSelection;
  try {
    selection = await selectConfiguredWorkshopPort();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const port = selection.port;
  const healthy = selection.alreadyRunning;
  if (healthy && pid) {
    console.log(`running on :${port} (pid ${pid})`);
    return 0;
  }
  if (healthy) {
    console.log(`running on :${port} (no pid file — started externally)`);
    return 0;
  }
  if (pid && processAlive(pid)) {
    const unhealthyPort = readPort() ?? requestedPort;
    console.log(`pid ${pid} alive but /health on :${unhealthyPort} not responding`);
    console.log("hint: raindrop workshop stop && raindrop workshop start");
    return 2;
  }
  console.log("not running");
  console.log("hint: start it with `raindrop workshop`, then open http://localhost:" + port);
  return 1;
}

/**
 * Default action when the user runs `raindrop workshop` with no further
 * subcommand: ensure the daemon is up, then open the UI in the browser.
 * Idempotent — re-running is harmless.
 */
async function cmdWorkshopDefault(): Promise<number> {
  let port: number;
  try {
    const result = await ensureDaemonRunning();
    port = result.port;
    if (!process.env.RAINDROP_SKIP_WORKSPACE_ACTIVATE) {
      try {
        await activateWorkspace(port, process.cwd());
      } catch (err) {
        console.warn(`[workshop] ${(err as Error).message}`);
      }
    }
    printPortFallback(result.requestedPort, result.port);
    printWorkshopAccess(result.port, { pid: result.pid, logs: !result.alreadyRunning || Boolean(result.pid) });
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const url = `http://localhost:${port}`;
  openInBrowser(url);
  return 0;
}

/**
 * `raindrop workshop setup` — bootstrap the current project to ship traces to
 * the local debugger. Three jobs, in order:
 *
 *   1. Write `RAINDROP_LOCAL_DEBUGGER=http://localhost:<port>/v1/` into
 *      ./.env (idempotent; won't clobber a different existing value unless
 *      `--force` is given).
 *   2. Start the daemon (or no-op if already running).
 *   3. Open the UI in the browser.
 *
 * The single command a new user runs after install. Designed to be the
 * shortest distance between "I just installed raindrop" and "my traces
 * appear in a browser".
 */
async function cmdWorkshopSetup(args: string[]): Promise<number> {
  let force = false;
  let envFile: string | null = null;
  let printOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") force = true;
    else if (a === "--print") printOnly = true;
    else if (a === "--file") envFile = args[++i] ?? null;
    else if (a.startsWith("--file=")) envFile = a.slice("--file=".length);
    else if (a === "--help" || a === "-h") {
      console.log(`raindrop workshop setup — bootstrap project for local trace debugging

USAGE
    raindrop workshop setup [--file=PATH] [--force] [--print]

WHAT IT DOES
    1. Writes RAINDROP_LOCAL_DEBUGGER=http://localhost:<port>/v1/ into ./.env
       (or --file=PATH). Idempotent — same line already present is a no-op.
    2. Starts the daemon if not already running.
    3. Opens the UI in the browser.

FLAGS
    --file=PATH   Target env file (default: ./.env in current directory).
    --force       Replace an existing RAINDROP_LOCAL_DEBUGGER line that
                  points elsewhere. Without this, setup bails on a conflict.
    --print       Don't modify any file; just print the export line and
                  skip start/open. Useful for shells that don't read .env.
`);
      return 0;
    } else {
      console.error(`unknown flag: ${a}`);
      return 64;
    }
  }

  let selection: WorkshopPortSelection;
  try {
    selection = await selectConfiguredWorkshopPort();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const port = selection.port;
  const targetLine = `RAINDROP_LOCAL_DEBUGGER=http://localhost:${port}/v1/`;

  if (printOnly) {
    console.log(targetLine);
    return 0;
  }

  const target = path.resolve(envFile ?? path.join(process.cwd(), ".env"));
  const writeResult = writeEnvLine(target, targetLine, { force });
  if (writeResult.kind === "conflict") {
    console.error(
      `[setup] ${target} has a different RAINDROP_LOCAL_DEBUGGER value:\n` +
        `  existing: ${writeResult.existing}\n` +
        `  proposed: ${targetLine}\n` +
        `re-run with --force to overwrite, or edit the file manually.`
    );
    return 2;
  }
  if (writeResult.kind === "noop") {
    console.log(`[setup] ${target} already has RAINDROP_LOCAL_DEBUGGER — nothing to write`);
  } else {
    console.log(`[setup] wrote ${targetLine} to ${target}`);
  }

  // Start daemon + open UI. Failure here doesn't undo the env-write — that's
  // intentional, the env line is still useful even if the daemon is down.
  const runResult = await cmdWorkshopDefault();
  return runResult;
}

interface EnvWriteResult {
  kind: "wrote" | "noop" | "conflict";
  existing?: string;
}

/**
 * Idempotent line-level upsert into a `.env`-style file:
 *
 *   - File doesn't exist → create with the single line.
 *   - Line already present (exact match) → no-op.
 *   - Line key present but value differs:
 *       - force=true → replace the line.
 *       - force=false → return "conflict" without modifying the file.
 *   - Line key absent → append (preserving trailing newline shape).
 */
function writeEnvLine(file: string, line: string, opts: { force: boolean }): EnvWriteResult {
  const eq = line.indexOf("=");
  const key = line.slice(0, eq);
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=`);

  let original = "";
  let exists = false;
  try {
    original = fs.readFileSync(file, "utf8");
    exists = true;
  } catch { /* file doesn't exist — we'll create it */ }

  if (!exists) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, line + "\n");
    return { kind: "wrote" };
  }

  const lines = original.split("\n");
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx === -1) {
    const sep = original.endsWith("\n") || original.length === 0 ? "" : "\n";
    fs.writeFileSync(file, original + sep + line + "\n");
    return { kind: "wrote" };
  }
  if (lines[idx].trim() === line) {
    return { kind: "noop" };
  }
  if (!opts.force) {
    return { kind: "conflict", existing: lines[idx] };
  }
  lines[idx] = line;
  fs.writeFileSync(file, lines.join("\n"));
  return { kind: "wrote" };
}

function openInBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // `start` is a cmd.exe builtin; the empty "" is the window title arg.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // If we can't spawn (no DISPLAY, no `open` on a headless box), the URL
    // print earlier still lets the user navigate manually. Don't fail.
  }
}

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_PATH, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readPort(): number | null {
  try {
    const raw = fs.readFileSync(PORT_PATH, "utf8").trim();
    const port = parseInt(raw, 10);
    return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getWorkshopHealth(port: number): Promise<{ service?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body = await res.json() as { service?: string; pid?: number };
    return body.service === "workshop" ? body : null;
  } catch {
    return null;
  }
}

async function isHealthy(port: number): Promise<boolean> {
  return Boolean(await getWorkshopHealth(port));
}

async function activateWorkspace(port: number, cwd: string): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspace/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(`failed to activate workspace ${cwd}: ${(err as Error).message}`);
  }
}

function getConfiguredPort(): number {
  const port = parseInt(process.env[PORT_ENV] ?? String(DEFAULT_PORT), 10);
  if (Number.isInteger(port) && port >= 1 && port <= MAX_PORT) return port;
  return DEFAULT_PORT;
}

function hasExplicitPort(): boolean {
  return Boolean(process.env[PORT_ENV] && process.env[PORT_ENV]?.trim());
}

async function selectExactWorkshopPort(port: number): Promise<WorkshopPortSelection> {
  if (await isHealthy(port)) return { alreadyRunning: true, port };
  if (await isPortFree(port)) return { alreadyRunning: false, port };
  throw new Error(`:${port} is already in use by another process.`);
}

async function selectConfiguredWorkshopPort(): Promise<WorkshopPortSelection> {
  const requestedPort = getConfiguredPort();
  return hasExplicitPort()
    ? selectExactWorkshopPort(requestedPort)
    : selectWorkshopPort(requestedPort);
}

async function selectWorkshopPort(startPort: number): Promise<WorkshopPortSelection> {
  const savedPort = hasExplicitPort() ? null : readPort();
  if (savedPort && await isHealthy(savedPort)) {
    return { alreadyRunning: true, port: savedPort };
  }

  return findWorkshopPort(startPort);
}

async function findWorkshopPort(startPort: number): Promise<WorkshopPortSelection> {
  for (let port = startPort; port <= MAX_PORT; port++) {
    if (await isHealthy(port)) return { alreadyRunning: true, port };
    if (await isPortFree(port)) return { alreadyRunning: false, port };
  }

  throw new Error(`no usable port available at or above :${startPort}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printRootHelp(): void {
  console.log(`raindrop ${VERSION} — local-first trace debugger for AI agents

  Quick start:

      cd path/to/your-app
      raindrop workshop setup     Write .env, start the daemon, open the UI.

  Agent integrations:

      raindrop setup              Wire raindrop into supported agents
                                  (drops MCP + skill files in their config dirs).
      raindrop replay register    Register this project's replay config.

  Day-to-day:

      raindrop workshop           Start daemon + open UI (idempotent).
      raindrop workshop status    Is it running?
      raindrop workshop stop      Stop the daemon.
      raindrop workshop reset     Delete the local DB after confirmation.
      raindrop update             Update raindrop tooling.
      raindrop uninstall          Remove raindrop from this machine.

  More:  raindrop workshop setup --help · raindrop setup --help · raindrop uninstall --help
         github.com/raindrop-ai/workshop`);
}

async function dispatchReplay(verb: string | undefined, rest: string[]): Promise<number> {
  switch (verb) {
    case "register": {
      let cwd = process.cwd();
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--cwd") cwd = path.resolve(rest[++i] ?? process.cwd());
        else if (arg.startsWith("--cwd=")) cwd = path.resolve(arg.slice("--cwd=".length));
        else if (arg === "-h" || arg === "--help") {
          console.log(`raindrop replay register — register project replay config

USAGE
    raindrop replay register [--cwd=DIR]
`);
          return 0;
        } else {
          console.error(`unknown flag: ${arg}`);
          return 64;
        }
      }
      try {
        const result = await registerReplayProject(cwd);
        console.log("Registered replay project:");
        console.log(`  path: ${result.cwd}`);
        console.log(`  config: ${result.configPath}`);
        console.log("  agents:");
        for (const agent of result.agents) console.log(`    - eventName: ${agent}`);
        return 0;
      } catch (err) {
        console.error((err as Error).message);
        return 1;
      }
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(`raindrop replay — local agent replay helpers

USAGE
    raindrop replay register [--cwd=DIR]
`);
      return 0;
    default:
      console.error(`unknown subcommand: replay ${verb}`);
      return 64;
  }
}

function printWorkshopHelp(): void {
  const port = process.env[PORT_ENV] ?? "5899";
  console.log(`raindrop workshop ${VERSION} — local trace debugger

USAGE
    raindrop workshop                 Start daemon + open UI (idempotent).
    raindrop workshop setup [flags]   Write .env + start + open. The standard
                                       first command after install.

DAEMON
    start         Start in the background.
    stop          Stop the daemon.
    status        Is it running?
    serve         Run in the foreground.

OTHER
    update [flags]   Self-update (default: stable channel). See update --help.
    mcp              MCP server over stdio (used by Claude Code).
    reset            Delete the local Workshop DB after confirmation.

OPTIONS
    -h, --help    Print this help.
    -v, --version Print version.

ENVIRONMENT
    RAINDROP_WORKSHOP_PORT        Exact HTTP port. Without it, Workshop starts
                                  at ${port} and skips occupied ports upward.
    RAINDROP_WORKSHOP_DB_PATH     SQLite path
                                  (default: ~/.raindrop/raindrop_workshop.db).
    RAINDROP_MANIFEST_URL         Override update manifest URL (advanced).

DOCS
    https://github.com/raindrop-ai/workshop`);
}

async function dispatchWorkshop(verb: string | undefined, rest: string[]): Promise<number> {
  switch (verb) {
    case undefined:
      return cmdWorkshopDefault();
    case "setup":
      return cmdWorkshopSetup(rest);
    case "start":
      return cmdStart();
    case "stop":
      return cmdStop();
    case "reset":
      return cmdReset(rest);
    case "status":
      return cmdStatus();
    case "serve":
      await runBackend(); // never resolves
      return 0;
    case "update":
      return runUpdate(rest);
    case "mcp":
      await runMcp();
      return 0;
    case "-h":
    case "--help":
    case "help":
      printWorkshopHelp();
      return 0;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return 0;
    default:
      console.error(`unknown subcommand: workshop ${verb}`);
      console.error("run `raindrop workshop --help` for usage.");
      return 64;
  }
}

(async () => {
  const top = process.argv[2];
  switch (top) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printRootHelp();
      process.exit(0);
      break;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      process.exit(0);
      break;
    case "setup":
      // Umbrella setup: file-drop installer for raindrop into Cursor /
      // Claude Code. Distinct from `raindrop workshop setup`, which is
      // the per-project (.env + daemon + open UI) bootstrap.
      process.exit(await cmdSetup(process.argv.slice(3)));
      break;
    case "sync":
      // Refresh skill files + MCP entries in every place we previously
      // installed (per ~/.raindrop/install-registry.json). Auto-runs at
      // the tail of `raindrop update`; exposed as a public command for
      // manual refresh between releases.
      process.exit(await cmdSync(process.argv.slice(3)));
      break;
    case "drip": {
      const { cmdDrip } = await import("./drip");
      process.exit(await cmdDrip(process.argv.slice(3)));
      break;
    }
    case "replay":
      process.exit(await dispatchReplay(process.argv[3], process.argv.slice(4)));
      break;
    case "update":
      // Umbrella update: today, raindrop ships only the workshop product, so
      // this is a thin proxy. When other products land, this expands to
      // iterate-and-update each one.
      process.exit(await runUpdate(process.argv.slice(3)));
      break;
    case "uninstall":
      process.exit(await cmdUninstall(process.argv.slice(3)));
      break;
    case "workshop":
      process.exit(await dispatchWorkshop(process.argv[3], process.argv.slice(4)));
      break;
    default:
      console.error(`unknown subcommand: ${top}`);
      console.error("run `raindrop --help` for usage.");
      process.exit(64);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

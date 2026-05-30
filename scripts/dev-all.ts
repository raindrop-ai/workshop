#!/usr/bin/env bun
/**
 * dev-all: bring up the workshop daemon + every example app on stable, distinct
 * ports for end-to-end testing in a browser.
 *
 * This is the single entrypoint our declarative dev env (.devin/blueprint.yml)
 * relies on. Run it from the repo root:
 *
 *   bun run dev:examples
 *
 * What it does:
 *   1. Starts the workshop daemon in-process on $RAINDROP_WORKSHOP_PORT (default 5899).
 *      Workshop UI:     http://localhost:5899
 *      Trace ingest:    http://localhost:5899/v1/traces
 *      MCP (stdio):     bun src/index.ts workshop mcp
 *   2. Spawns every example app under examples/ as a child `bun` process,
 *      each with a stable port and RAINDROP_LOCAL_DEBUGGER pointed at (1).
 *   3. Tees each child's stdout/stderr through a colored, prefixed logger so
 *      a single shell tab is enough to follow the whole stack.
 *   4. On Ctrl-C, broadcasts SIGINT to every child and waits for them to exit
 *      before tearing the daemon down.
 *
 * Examples run in their own working dir + their own node_modules, so version
 * skew across raindrop-ai variants (e.g. ai-sdk-otelv2 pins a different
 * raindrop-ai release than the rest of the repo) does not bleed across.
 *
 * Adding a new example: drop it in `EXAMPLE_APPS` below. Anything that has a
 * `server.ts` exporting `startServer()` and self-hosts when run directly will
 * Just Work.
 */
import { spawn, spawnSync, type Subprocess } from "bun";
import path from "path";
import fs from "fs";
import { WORKSHOP_BIND_HOST } from "../src/local-access";
import { createServer } from "../src/server";
import { getDbPath } from "../src/db";

function pidOnPort(port: number): string | null {
  try {
    const r = spawnSync(["lsof", "-ti", `:${port}`, "-sTCP:LISTEN"]);
    const pid = new TextDecoder().decode(r.stdout).trim().split("\n")[0];
    return pid || null;
  } catch {
    return null;
  }
}

function checkPortsOrExit(ports: { port: number; label: string }[]): void {
  const conflicts = ports
    .map((p) => ({ ...p, pid: pidOnPort(p.port) }))
    .filter((p): p is typeof p & { pid: string } => p.pid !== null);
  if (conflicts.length === 0) return;
  console.error("\n  Cannot start dev:examples — ports already in use:\n");
  for (const c of conflicts) {
    console.error(`    :${c.port}  ${c.label.padEnd(22)} pid=${c.pid}`);
  }
  console.error(`\n  Free them and retry:`);
  console.error(`    kill -9 ${conflicts.map((c) => c.pid).join(" ")}\n`);
  process.exit(1);
}

function binOnPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(":").some((dir) => {
    try {
      return fs.existsSync(path.join(dir, bin));
    } catch {
      return false;
    }
  });
}

// The daemon's SPA fallthrough sends every non-API route to
// app/dist/index.html (src/server.ts → resolveBuiltAppDir); without a build
// it 500s on the first browser hit. Aborts on failure — no bundle, no UI.
function ensureWorkshopUi(): void {
  const indexHtml = path.join(REPO_ROOT, "app", "dist", "index.html");
  if (fs.existsSync(indexHtml)) return;

  console.log("\x1b[2m  Building workshop UI bundle (app/dist/)…\x1b[0m");
  const r = spawnSync(["bun", "run", "build:ui"], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) {
    console.error(
      `\n  bun run build:ui failed (exit ${r.exitCode}). The workshop daemon needs app/dist/index.html to serve the UI; cannot continue.\n`,
    );
    process.exit(1);
  }
}

// `@anthropic-ai/claude-agent-sdk` declares both `@anthropic-ai/claude-agent-sdk-linux-x64`
// (glibc) and `@anthropic-ai/claude-agent-sdk-linux-x64-musl` (musl) as
// optional native deps. Bun's resolver installs *both* regardless of the
// host's libc, and the SDK's binary lookup walks them in order
// `[…-musl, …(glibc)]`, returning the first one whose path resolves. On a
// glibc host the musl binary's dynamic linker (`/lib/ld-musl-x86_64.so.1`)
// is missing, so when the SDK's child process spawns we get the user-facing
// error: "Claude Code native binary not found at …-linux-x64-musl/claude."
//
// `.devin/setup.sh` already prunes the wrong variant at install time, but
// per-example `bun install --silent` runs (via `ensureBunDeps`) can pull
// it back into the example's own `node_modules/`. Re-prune on every boot
// so dev:examples is idempotent against state drift.
function pruneWrongClaudeAgentSdkLibcVariant(): void {
  if (process.platform !== "linux") return;
  let hostLibc: "musl" | "glibc";
  try {
    const lddVersion = spawnSync(["ldd", "--version"]);
    const out = (
      new TextDecoder().decode(lddVersion.stdout) +
      new TextDecoder().decode(lddVersion.stderr)
    ).toLowerCase();
    hostLibc = out.includes("musl") ? "musl" : "glibc";
  } catch {
    hostLibc = "glibc";
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const wrongVariant =
    hostLibc === "glibc"
      ? `claude-agent-sdk-linux-${arch}-musl`
      : `claude-agent-sdk-linux-${arch}`;

  const queue: string[] = [REPO_ROOT];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (e.name === "node_modules") {
        const wrong = path.join(child, "@anthropic-ai", wrongVariant);
        if (fs.existsSync(wrong)) {
          console.log(
            `\x1b[2m  Removing ${wrongVariant} native binary at ${wrong} (host is ${hostLibc})\x1b[0m`,
          );
          fs.rmSync(wrong, { recursive: true, force: true });
        }
        // Don't recurse into node_modules — only top-level node_modules trees
        // own these optional deps, and walking deep is expensive.
        continue;
      }
      if (e.name === ".git" || e.name.startsWith(".")) continue;
      queue.push(child);
    }
  }
}

// macOS ships `python3` → 3.9, too old for raindrop-ai (requires ≥ 3.10);
// prefer a Homebrew `python3.12` / `python3.13` when one is on PATH.
function pickPython3(): string | null {
  for (const candidate of [
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
  ]) {
    if (binOnPath(candidate)) return candidate;
  }
  return null;
}

type ExampleRuntime = "bun" | "python" | "rust" | "go";

interface ExampleApp {
  /** Folder name under `examples/`. */
  name: string;
  /** Stable port that the orchestrator pins this example to. */
  port: number;
  /** Human-readable label printed in the URL summary + log prefix. */
  label: string;
  /** Toolchain used to spawn the example. Defaults to `bun`. */
  runtime?: ExampleRuntime;
  /**
   * Optional precondition checks. If any returns a non-empty string,
   * the example is skipped and the message is shown instead.
   */
  skipIf?: () => string | null;
}

const ENTRYPOINT_BY_RUNTIME: Record<ExampleRuntime, string> = {
  bun: "server.ts",
  python: "server.py",
  rust: "Cargo.toml",
  go: "go.mod",
};

function spawnCmdFor(runtime: ExampleRuntime, cwd: string): string[] {
  switch (runtime) {
    case "python": {
      const venvPython = path.join(cwd, ".venv", "bin", "python");
      const py = fs.existsSync(venvPython) ? venvPython : "python3";
      return [py, "server.py"];
    }
    case "rust":
      return ["cargo", "run", "--quiet"];
    case "go":
      return ["go", "run", "."];
    case "bun":
      return ["bun", "server.ts"];
  }
}

// Each example pins its own dep set (e.g. ai-sdk-otelv2 vs the root
// raindrop-ai); without a local `node_modules/` bun's upward bare-import
// resolution silently falls back to the workshop's hoisted deps.
function ensureBunDeps(app: ExampleApp, cwd: string): string | null {
  if ((app.runtime ?? "bun") !== "bun") return null;
  if (fs.existsSync(path.join(cwd, "node_modules"))) return null;
  if (!fs.existsSync(path.join(cwd, "package.json"))) return null;

  console.log(
    `\x1b[2m  Installing dependencies for examples/${app.name}…\x1b[0m`,
  );
  const r = spawnSync(["bun", "install", "--silent"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) {
    return `bun install failed (exit ${r.exitCode}) — run \`cd examples/${app.name} && bun install\``;
  }
  return null;
}

function ensurePythonVenv(app: ExampleApp, cwd: string): string | null {
  if (app.runtime !== "python") return null;
  const venvPython = path.join(cwd, ".venv", "bin", "python");
  if (fs.existsSync(venvPython)) return null;

  const python = pickPython3();
  if (!python) return null;

  const requirements = path.join(cwd, "requirements.txt");
  console.log(
    `\x1b[2m  Bootstrapping python venv for examples/${app.name} (${python})…\x1b[0m`,
  );
  const venv = spawnSync([python, "-m", "venv", ".venv"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (venv.exitCode !== 0) {
    return `${python} -m venv failed (exit ${venv.exitCode}) — run \`cd examples/${app.name} && ${python} -m venv .venv && .venv/bin/pip install -r requirements.txt\``;
  }
  if (fs.existsSync(requirements)) {
    const pip = spawnSync(
      [path.join(cwd, ".venv", "bin", "pip"), "install", "-q", "-r", "requirements.txt"],
      { cwd, stdout: "inherit", stderr: "inherit" },
    );
    if (pip.exitCode !== 0) {
      return `pip install failed (exit ${pip.exitCode}) — run \`cd examples/${app.name} && .venv/bin/pip install -r requirements.txt\` (raindrop-ai requires python ≥ 3.10; verify your venv interpreter)`;
    }
  }
  return null;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const EXAMPLE_APPS: ExampleApp[] = [
  { name: "ai-sdk-chat", port: 3011, label: "AI SDK chat" },
  { name: "openai-chat", port: 3012, label: "OpenAI chat" },
  { name: "anthropic-chat", port: 3013, label: "Anthropic chat" },
  { name: "ai-sdk-otelv2", port: 3014, label: "AI SDK (OTel v2)" },
  { name: "browser-chat", port: 3016, label: "Browser SDK chat" },
  { name: "claude-agent-sdk", port: 3015, label: "Claude Agent SDK" },
  {
    name: "python-chat",
    port: 3017,
    label: "Python SDK chat",
    runtime: "python",
    skipIf: () =>
      pickPython3() ? null : "python3 not found on PATH — install python ≥ 3.10 via your OS package manager or python.org",
  },
  {
    name: "rust-chat",
    port: 3018,
    label: "Rust SDK chat",
    runtime: "rust",
    skipIf: () =>
      binOnPath("cargo") ? null : "cargo not found on PATH — install via rustup",
  },
  {
    name: "go-chat",
    port: 3019,
    label: "Go SDK chat",
    runtime: "go",
    skipIf: () =>
      binOnPath("go") ? null : "go not found on PATH — install via brew or go.dev",
  },
  {
    name: "pi-agent-chat",
    port: 3020,
    label: "Pi Agent chat",
  },
  {
    name: "opencode-plugin-chat",
    port: 3021,
    label: "OpenCode + Raindrop plugin",
    skipIf: () =>
      binOnPath("opencode")
        ? null
        : "opencode CLI not found on PATH — install via `npm install -g opencode-ai` or per opencode.ai/install",
  },
  {
    name: "opencode-observer-agent",
    port: 3031,
    label: "OpenCode observer agent",
    skipIf: () =>
      binOnPath("opencode")
        ? null
        : "opencode CLI not found on PATH — install via `npm install -g opencode-ai` or per opencode.ai/install",
  },
];

const PALETTE = ["36", "33", "35", "32", "34", "31"];
function color(idx: number, text: string): string {
  const code = PALETTE[idx % PALETTE.length];
  return `\x1b[${code}m${text}\x1b[0m`;
}

function listen(server: ReturnType<typeof createServer> extends Promise<infer R> ? R extends { server: infer S } ? S : never : never, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, WORKSHOP_BIND_HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else resolve(port);
    });
  });
}

interface RunningChild {
  app: ExampleApp;
  proc: Subprocess;
  logIdx: number;
}

async function pipeWithPrefix(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  sink: typeof process.stdout | typeof process.stderr,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) sink.write(`${prefix} ${line}\n`);
  }
  if (buf) sink.write(`${prefix} ${buf}\n`);
}

async function main(): Promise<void> {
  const debuggerPort = Number(process.env.RAINDROP_WORKSHOP_PORT ?? 5899);

  // Before port check: a missing bundle is the slower, fail-fast condition.
  ensureWorkshopUi();

  checkPortsOrExit([
    { port: debuggerPort, label: "Workshop daemon" },
    ...EXAMPLE_APPS
      .filter((a) => !a.skipIf?.())
      .map((a) => ({ port: a.port, label: a.name })),
  ]);

  const { server } = await createServer(debuggerPort);
  const boundDebuggerPort = await listen(server, debuggerPort);

  const debuggerBase = `http://127.0.0.1:${boundDebuggerPort}`;
  const debuggerIngest = `${debuggerBase}/v1/`;

  // Examples discover the local daemon via these env vars. Don't clobber if
  // the operator already pointed them somewhere else (e.g. a remote endpoint).
  process.env.RAINDROP_LOCAL_DEBUGGER ??= debuggerIngest;
  process.env.RAINDROP_ENDPOINT ??= process.env.RAINDROP_LOCAL_DEBUGGER;

  const children: RunningChild[] = [];
  const skipped: { app: ExampleApp; reason: string }[] = [];

  // Rust + Go fetch their own deps at `cargo run` / `go run` time.
  const installFailures = new Map<string, string>();
  for (const app of EXAMPLE_APPS) {
    if (app.skipIf?.()) continue;
    const cwd = path.join(REPO_ROOT, "examples", app.name);
    const err = ensureBunDeps(app, cwd) ?? ensurePythonVenv(app, cwd);
    if (err) installFailures.set(app.name, err);
  }

  // Per-example `bun install --silent` above may have re-introduced the
  // wrong libc variant of @anthropic-ai/claude-agent-sdk's native binary
  // into examples/claude-agent-sdk/node_modules/. Re-prune now so the SDK
  // picks the binary that actually runs on this host.
  pruneWrongClaudeAgentSdkLibcVariant();

  for (let idx = 0; idx < EXAMPLE_APPS.length; idx++) {
    const app = EXAMPLE_APPS[idx];
    const skipReason = app.skipIf?.() ?? null;
    if (skipReason) {
      skipped.push({ app, reason: skipReason });
      continue;
    }

    const installError = installFailures.get(app.name);
    if (installError) {
      skipped.push({ app, reason: installError });
      continue;
    }

    const cwd = path.join(REPO_ROOT, "examples", app.name);
    const runtime: ExampleRuntime = app.runtime ?? "bun";
    const entrypoint = ENTRYPOINT_BY_RUNTIME[runtime];
    if (!fs.existsSync(path.join(cwd, entrypoint))) {
      skipped.push({ app, reason: `examples/${app.name}/${entrypoint} missing` });
      continue;
    }

    const env = {
      ...process.env,
      PORT: String(app.port),
      RAINDROP_LOCAL_DEBUGGER: process.env.RAINDROP_LOCAL_DEBUGGER!,
      RAINDROP_ENDPOINT: process.env.RAINDROP_ENDPOINT!,
    };

    const proc = spawn({
      cmd: spawnCmdFor(runtime, cwd),
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const logIdx = idx;
    const prefix = color(logIdx, `[${app.name.padEnd(18)}]`);
    void pipeWithPrefix(proc.stdout as ReadableStream<Uint8Array>, prefix, process.stdout);
    void pipeWithPrefix(proc.stderr as ReadableStream<Uint8Array>, prefix, process.stderr);

    children.push({ app, proc, logIdx });
  }

  // Print the "you can now click these" summary once everything is launched.
  // Do this after a short tick so the children's startup banners settle.
  await new Promise((r) => setTimeout(r, 250));

  const banner = (text: string) => `\x1b[1m${text}\x1b[0m`;
  console.log("");
  console.log(banner("  Raindrop Workshop is running"));
  console.log("");
  console.log(`  ${"Workshop UI".padEnd(18)}  ${debuggerBase}`);
  console.log(`  ${"Workshop ingest".padEnd(18)}  ${debuggerBase}/v1/traces`);
  console.log(`  ${"Workshop MCP".padEnd(18)}  bun src/index.ts workshop mcp`);
  console.log(`  ${"Workshop DB".padEnd(18)}  ${getDbPath()}`);
  console.log("");
  for (const child of children) {
    console.log(
      `  ${child.app.label.padEnd(18)}  http://127.0.0.1:${child.app.port}`,
    );
  }
  for (const { app, reason } of skipped) {
    console.log(
      `  ${app.label.padEnd(18)}  \x1b[2m(skipped: ${reason})\x1b[0m`,
    );
  }
  console.log("");
  console.log("  Ctrl-C to stop everything.");
  console.log("");

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down ${children.length} example app(s)…`);
    for (const child of children) {
      try {
        child.proc.kill(signal);
      } catch {
        // child may already be gone
      }
    }
    // Give children up to 5s to exit cleanly, then SIGKILL stragglers.
    const deadline = Date.now() + 5_000;
    for (const child of children) {
      const remaining = Math.max(0, deadline - Date.now());
      await Promise.race([
        child.proc.exited,
        new Promise((r) => setTimeout(r, remaining)),
      ]);
      if (child.proc.exitCode === null) {
        try {
          child.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Surface unexpected child exits — if a single example dies, log it but keep
  // the rest running. Operators usually want to fix the broken one and re-run.
  await Promise.all(
    children.map(async (child) => {
      const code = await child.proc.exited;
      if (!shuttingDown && code !== 0 && code !== null) {
        console.error(
          `\x1b[31m[${child.app.name}] exited with code ${code}\x1b[0m`,
        );
      }
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

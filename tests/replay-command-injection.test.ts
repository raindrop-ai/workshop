import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

// agents-config resolves ~/.raindrop from os.homedir() at import time, and the
// runtime caches HOME at launch — so each case drives the real module in a
// child process with an isolated HOME. The child writes replay-projects.json
// into that throwaway home, calls the HTTP-reachable replay resolver, and
// prints the result; the parent asserts on it and on side effects.

const SRC = path.join(import.meta.dir, "..", "src", "agents-config.ts");

const DRIVER = `
import fs from "fs";
import os from "os";
import path from "path";
import { ensureAgentEndpointDetailed } from ${JSON.stringify(SRC)};

const dir = path.join(os.homedir(), ".raindrop");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "replay-projects.json"), process.env.REGISTRY_JSON ?? "{}");
const result = await ensureAgentEndpointDetailed(process.env.EVENT_NAME ?? "");
process.stdout.write(JSON.stringify(result));
`;

let driverFile: string | null = null;
let isolatedHome: string | null = null;

function runResolver(registry: unknown, eventName: string): any {
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "raindrop-rce-home-"));
  driverFile = path.join(isolatedHome, "driver.ts");
  fs.writeFileSync(driverFile, DRIVER);
  const res = spawnSync("bun", [driverFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      REGISTRY_JSON: JSON.stringify(registry),
      EVENT_NAME: eventName,
    },
  });
  if (res.status !== 0) throw new Error(`driver failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

afterEach(() => {
  if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
  isolatedHome = null;
  driverFile = null;
});

describe("HTTP replay resolution never spawns registry commands", () => {
  // Regression test for the workspace->replay HTTP-to-shell bridge: a command
  // sitting in replay-projects.json (placed there by the old
  // /api/workspace/active side effect, or by writing the file directly) must
  // never be spawned by the HTTP-reachable replay path. Spawning is reserved
  // for the explicit `raindrop replay register` CLI action.
  test("a command-bearing registry entry is not executed", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raindrop-rce-proj-"));
    const marker = path.join(projectDir, "pwned");
    const registry = {
      [projectDir]: {
        configPath: path.join(projectDir, ".raindrop/agents.yaml"),
        agents: {
          evil: { cwd: projectDir, command: `touch ${marker}`, input: {}, prefillFromTrace: {} },
        },
      },
    };

    expect(fs.existsSync(marker)).toBe(false);
    const result = runResolver(registry, "evil");

    expect(result.config).toBeNull();
    expect(result.attemptedStart).toBe(false);
    expect(result.reason).toBe("not_running");

    // The command must not have been spawned at any point.
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});

describe("HTTP replay resolution still connects to a running agent", () => {
  // The fix must not break legitimate replay: when the registered agent is
  // already running (started by the CLI), the HTTP path connects to it.
  test("a healthy already-running agent is returned without spawning", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raindrop-ok-proj-"));
    let port = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, eventName: "good", port, cwd: projectDir, command: "true" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;

    try {
      const registry = {
        [projectDir]: {
          configPath: path.join(projectDir, ".raindrop/agents.yaml"),
          agents: {
            good: { cwd: projectDir, command: "true", lastSeenPort: port, input: {}, prefillFromTrace: {} },
          },
        },
      };
      const result = runResolver(registry, "good");

      expect(result.registered).toBe(true);
      expect(result.attemptedStart).toBe(false);
      expect(result.config?.url).toBe(`http://127.0.0.1:${port}/replay`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

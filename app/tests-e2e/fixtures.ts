import { test as base, expect } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export type WorkshopHandle = {
  url: string;
  dbPath: string;
  port: number;
};

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`workshop /health never came up at ${url}: ${String(lastErr)}`);
}

async function stopProc(p: ChildProcess): Promise<void> {
  if (p.exitCode != null || p.signalCode != null) return;
  return new Promise<void>((resolve) => {
    const onExit = () => resolve();
    p.once("exit", onExit);
    try {
      p.kill("SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, 2500);
  });
}

export const test = base.extend<{ workshop: WorkshopHandle }, { workshopWorker: WorkshopHandle }>({
  // One workshop daemon per Playwright worker — isolated DB, isolated port.
  // Specs that need to inspect DB state can read workshop.url + /api/runs.
  workshopWorker: [
    async ({}, use, workerInfo) => {
      const port = 5910 + workerInfo.workerIndex;
      const tmp = mkdtempSync(path.join(tmpdir(), `rd-workshop-w${workerInfo.workerIndex}-`));
      const dbPath = path.join(tmp, "workshop.db");
      const stateDir = path.join(tmp, "state");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      mkdirSync(stateDir, { recursive: true });

      const proc = spawn("bun", ["src/index.ts", "workshop", "serve"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          RAINDROP_WORKSHOP_PORT: String(port),
          RAINDROP_WORKSHOP_DB_PATH: dbPath,
          RAINDROP_WORKSHOP_STATE_DIR: stateDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const logs: string[] = [];
      proc.stdout?.on("data", (d) => logs.push(`[ws ${port}] ${d}`));
      proc.stderr?.on("data", (d) => logs.push(`[ws ${port}!] ${d}`));

      try {
        await waitForHealth(`http://localhost:${port}`, 15_000);
      } catch (err) {
        // surface the daemon's own logs so CI failures are diagnosable
        console.error(logs.slice(-50).join(""));
        throw err;
      }

      await use({ url: `http://localhost:${port}`, dbPath, port });
      await stopProc(proc);
    },
    { scope: "worker" },
  ],
  workshop: async ({ workshopWorker }, use) => use(workshopWorker),
});

export { expect };
export const REPO_ROOT_PATH = REPO_ROOT;

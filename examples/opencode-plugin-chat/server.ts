import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Express } from "express";
import { loadWorkspaceEnv } from "../loadEnv.ts";

loadWorkspaceEnv(import.meta.url);

const DEFAULT_PORT = Number(process.env.PORT ?? 3021);
const DEFAULT_MODEL = "openai/gpt-4o-mini";

const WORKSHOP_BASE = (() => {
  const raw = process.env.RAINDROP_LOCAL_DEBUGGER ?? process.env.RAINDROP_LOCAL_WORKSHOP_URL ?? "";
  if (!raw) return "http://localhost:5899";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://localhost:5899";
  }
})();

// opencode-plugin's `convo_id` is opencode's own session ID, opaque to this
// server. Poll all runs and pick the freshest matching event_name.
async function resolveWorkshopRunUrl(startedAfter: number): Promise<string | null> {
  for (let i = 0; i < 15; i++) {
    try {
      const rows = (await (await fetch(`${WORKSHOP_BASE}/api/runs`)).json()) as Array<{
        id: string;
        event_name?: string;
        started_at?: number;
      }>;
      const hit = rows
        .filter((r) => r.event_name === "opencode_session" && (r.started_at ?? 0) >= startedAfter)
        .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
      if (hit) return `${WORKSHOP_BASE}/runs/${encodeURIComponent(hit.id)}`;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const PLUGIN_PACKAGE = "@raindrop-ai/opencode-plugin";
const PLUGIN_LINK_TARGET = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "node_modules",
  PLUGIN_PACKAGE,
);

const SEED_FILES: Record<string, string> = {
  "README.md":
    "# Demo Project\n\n" +
    "Tiny sandbox for the Raindrop + OpenCode example app. The agent has\n" +
    "shell + read/write/edit/glob tools available against everything here.\n\n" +
    "Files:\n" +
    "- `README.md` — this file\n" +
    "- `app.json` — package metadata\n" +
    "- `package.json` — Node manifest\n" +
    "- `src/index.js` — tiny CLI entrypoint\n" +
    "- `src/utils.js` — helpers used by index.js\n" +
    "- `data/customers.csv` — three rows of fake customer data\n" +
    "- `data/notes.md` — short rollout notes\n",
  "app.json": JSON.stringify(
    { name: "demo-app", version: "1.0.0", description: "Sample for OpenCode + Raindrop" },
    null,
    2,
  ) + "\n",
  "package.json": JSON.stringify(
    {
      name: "opencode-demo",
      version: "1.0.0",
      type: "module",
      scripts: { start: "node src/index.js" },
    },
    null,
    2,
  ) + "\n",
  "src/index.js":
    "import { greet } from \"./utils.js\";\n\n" +
    "const name = process.argv[2] ?? \"world\";\n" +
    "console.log(greet(name));\n",
  "src/utils.js":
    "export function greet(name) {\n" +
    "  return `Hello, ${name}!`;\n" +
    "}\n",
  "data/customers.csv":
    "id,name,tier,active_deployments\n" +
    "cust-acme-001,Acme,enterprise,3\n" +
    "cust-bravo-002,Bravo,growth,1\n" +
    "cust-charlie-003,Charlie,enterprise,2\n",
  "data/notes.md":
    "# Rollout notes\n\n" +
    "- Stage traffic shifts before flipping defaults.\n" +
    "- Capture an operator summary in `summary.md` after every cutover.\n",
};

function setupOpencodeWorkspace(): string {
  const dir = path.join(tmpdir(), `raindrop-opencode-plugin-chat-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [`file://${PLUGIN_LINK_TARGET}`],
      },
      null,
      2,
    ),
  );
  for (const [name, contents] of Object.entries(SEED_FILES)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  // opencode walks up looking for a project marker (`.git`); without one in the
  // sandbox it climbs to the nearest ancestor `.git` and treats that as the
  // workspace. The bare `git init` keeps tools scoped to the sandbox; the
  // hooks/*.sample cleanup keeps the agent's file enumeration short.
  if (!existsSync(path.join(dir, ".git"))) {
    spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const hooksDir = path.join(dir, ".git", "hooks");
    if (existsSync(hooksDir)) rmSync(hooksDir, { recursive: true, force: true });
  }
  return dir;
}

function resetSeedFiles(dir: string): void {
  for (const [name, contents] of Object.entries(SEED_FILES)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function envForOpencode(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // opencode reads $PWD before falling back to getcwd() when picking the
    // project root, so spawn({ cwd }) alone leaks the parent's workspace.
    PWD: cwd,
    HOME: homedir(),
    RAINDROP_EVENT_METADATA: JSON.stringify({
      userId: "example-user",
      properties: { example: "opencode-plugin-chat" },
    }),
  };
}

const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop OpenCode Plugin Chat</title>
    <link rel="icon" href="data:," />
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      .container { display: flex; flex-direction: column; height: 100vh; max-width: 760px; margin: 0 auto; padding: 1.5rem; box-sizing: border-box; }
      .scrollable { flex: 1; overflow-y: auto; padding-right: .5rem; }
      .input-bar { flex-shrink: 0; padding-top: 1rem; margin-top: 1rem; border-top: 1px solid #e5e7eb; }
      h1 { margin: 0 0 .25rem; font-size: 18px; }
      textarea, input { width: 100%; box-sizing: border-box; font: inherit; }
      textarea { min-height: 60px; }
      button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: white; font: inherit; cursor: pointer; }
      button:disabled { opacity: .6; cursor: wait; }
      button.secondary { background: none; color: #555; border-color: #d1d5db; margin-left: .5rem; }
      label { display: block; font-size: 12px; color: #666; margin: .5rem 0 .15rem; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem .75rem; }
      details summary { cursor: pointer; font-size: 12px; color: #666; }
      .history { margin-top: 1.25rem; display: flex; flex-direction: column; gap: .75rem; }
      .bubble { padding: .5rem .75rem; border-radius: 8px; }
      .bubble-user { background: #eff6ff; border: 1px solid #dbeafe; }
      .bubble-assistant { background: #f4f4f4; border: 1px solid #e5e7eb; font-family: ui-monospace, monospace; font-size: 13px; }
      .bubble-role { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .25rem; font-family: sans-serif; }
      .bubble-content { white-space: pre-wrap; min-height: 1em; }
      .bubble-link { display: block; margin-top: .35rem; font-size: 11px; color: #2563eb; text-decoration: none; font-family: sans-serif; }
      .bubble-link:hover { text-decoration: underline; }
      .actions { display: flex; align-items: center; margin-top: .5rem; }
      .status { margin-left: .75rem; font-size: 13px; color: #666; }
      .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #2563eb; margin-right: .35rem; vertical-align: middle; animation: pulse 1s infinite; }
      @keyframes pulse { 50% { opacity: .25; } }
      .hint { font-size: 11px; color: #888; margin: .5rem 0 0; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="scrollable" id="scrollable">
        <h1>OpenCode + Raindrop Plugin</h1>
        <p>Each turn spawns <code>opencode run</code> in a dedicated sandbox workspace whose <code>opencode.json</code> loads <code>@raindrop-ai/opencode-plugin</code>. The plugin streams session, message, and tool spans (read / list / write / shell / etc.) straight to your local Workshop daemon — one trace per turn.</p>

        <details open>
          <summary>Sandbox files (read-only display)</summary>
          <pre id="seedFiles" style="background:#fafafa; border:1px solid #eee; padding:.5rem; font-size:11px; max-height:200px; overflow:auto; margin: .25rem 0 .5rem; white-space:pre-wrap;">README.md
app.json
package.json
opencode.json
src/index.js
src/utils.js
data/customers.csv
data/notes.md</pre>
          <p class="hint">Reset wipes the workspace's last opencode session AND restores these files to their seed contents (in case the agent overwrote them).</p>
        </details>

        <div class="row">
          <div><label>Model (provider/id)</label><input id="model" placeholder="${DEFAULT_MODEL}" /></div>
          <div><label>Continue session</label><input id="continue" type="checkbox" checked /></div>
        </div>
        <p class="hint">opencode reads provider creds from its own credential store (<code>opencode auth login</code>) or from env vars (e.g. <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>). The first turn starts a fresh session; toggling "Continue session" off resets and starts a new session next turn.</p>

        <div id="history" class="history"></div>
      </div>

      <div class="input-bar">
        <textarea id="prompt" placeholder="Type a message. Cmd/Ctrl+Enter to send. Reset clears the last session and restores sandbox files.">Audit this project: glob every source file, read README.md and data/notes.md, then write a fresh data/summary.md that lists each customer from data/customers.csv with their tier and active deployment count. Finally, run \`wc -l data/summary.md\` to confirm the file size and report the result.</textarea>
        <div class="actions">
          <button id="send">Send</button>
          <button id="reset" class="secondary">Reset</button>
          <span id="status" class="status" hidden></span>
        </div>
      </div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const str = (id) => $(id).value || null;
      const FOOTER_RE = /\\n\\n\u2192 Open in Workshop: (\\S+)\\s*$/;
      const statusEl = $("status");
      const historyEl = $("history");
      const scrollableEl = $("scrollable");
      const messages = [];

      function setStatus(text) {
        if (!text) { statusEl.hidden = true; statusEl.innerHTML = ""; return; }
        statusEl.hidden = false;
        statusEl.innerHTML = '<span class="dot"></span>' + text;
      }

      function renderHistory() {
        const wasAtBottom =
          scrollableEl.scrollHeight - scrollableEl.scrollTop - scrollableEl.clientHeight < 60;
        historyEl.innerHTML = "";
        for (const m of messages) {
          const div = document.createElement("div");
          div.className = "bubble bubble-" + m.role;
          const role = document.createElement("div");
          role.className = "bubble-role";
          role.textContent = m.role;
          const content = document.createElement("div");
          content.className = "bubble-content";
          content.textContent = m.content;
          div.appendChild(role);
          div.appendChild(content);
          if (m.workshopUrl) {
            const a = document.createElement("a");
            a.className = "bubble-link";
            a.href = m.workshopUrl;
            a.target = "_blank";
            a.rel = "noreferrer";
            a.textContent = "Open run in Workshop \u2197";
            div.appendChild(a);
          }
          historyEl.appendChild(div);
        }
        if (wasAtBottom) scrollableEl.scrollTop = scrollableEl.scrollHeight;
      }

      $("reset").onclick = async () => {
        if ($("send").disabled) return;
        await fetch("/api/reset", { method: "POST" });
        messages.length = 0;
        renderHistory();
      };

      $("prompt").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !$("send").disabled) {
          e.preventDefault();
          $("send").click();
        }
      });

      $("send").onclick = async () => {
        const userText = $("prompt").value.trim();
        if (!userText) return;
        messages.push({ role: "user", content: userText });
        $("prompt").value = "";
        const asstIdx = messages.length;
        messages.push({ role: "assistant", content: "" });
        renderHistory();

        $("send").disabled = true;
        setStatus("Spawning opencode\u2026");
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: userText,
              model: str("model"),
              continueSession: $("continue").checked,
            }),
          });
          if (!res.ok) {
            messages[asstIdx].content = "[error] " + res.status + " " + res.statusText + ": " + (await res.text());
            renderHistory();
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let firstChunk = true;
          let raw = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstChunk) { setStatus("Streaming opencode output\u2026"); firstChunk = false; }
            raw += decoder.decode(value, { stream: true });
            const m = raw.match(FOOTER_RE);
            if (m) {
              messages[asstIdx].content = raw.slice(0, m.index);
              messages[asstIdx].workshopUrl = m[1];
            } else {
              messages[asstIdx].content = raw;
            }
            renderHistory();
          }
        } finally {
          $("send").disabled = false;
          setStatus("");
        }
      };
    </script>
  </body>
</html>`;

interface ChatRequest {
  input: string;
  model?: string | null;
  continueSession?: boolean;
}

let workspaceDir: string | null = null;
let lastSessionStarted = false;

function workspace(): string {
  if (!workspaceDir) {
    workspaceDir = setupOpencodeWorkspace();
    console.log(`OpenCode workspace: ${workspaceDir}`);
  }
  return workspaceDir;
}

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.type("html").send(HTML);
  });

  app.post("/api/chat", async (req, res) => {
    const body = (req.body ?? {}) as ChatRequest;
    const userInput = body.input?.trim();
    if (!userInput) {
      res.status(400).type("text/plain").send("input required");
      return;
    }
    const model = body.model?.trim() || DEFAULT_MODEL;
    const cwd = workspace();

    const args = ["run", "--format", "default", "--model", model];
    if (body.continueSession && lastSessionStarted) args.push("--continue");
    args.push(userInput);

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    const startedAt = Date.now();
    const child = spawn("opencode", args, {
      cwd,
      env: envForOpencode(cwd),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const writeChunk = (chunk: Buffer | string) => {
      try {
        res.write(chunk);
      } catch {
        // client disconnected; let opencode finish to flush plugin telemetry
      }
    };

    child.stdout.on("data", writeChunk);
    child.stderr.on("data", writeChunk);

    const exitCode: number = await new Promise((resolve) => {
      child.once("error", (err) => {
        writeChunk(`\n[spawn error] ${err.message}`);
        resolve(1);
      });
      child.once("close", (code) => resolve(code ?? 0));
    });

    if (exitCode === 0) {
      lastSessionStarted = true;
    }

    const workshopUrl = await resolveWorkshopRunUrl(startedAt);
    if (workshopUrl) {
      res.write(`\n\n→ Open in Workshop: ${workshopUrl}`);
    }
    res.end();
  });

  app.post("/api/reset", (_req, res) => {
    lastSessionStarted = false;
    if (workspaceDir) resetSeedFiles(workspaceDir);
    res.status(204).end();
  });

  return app;
}

export async function startServer(port = DEFAULT_PORT): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp();
  return new Promise((resolve) => {
    const server: Server = app.listen(port, () => {
      const addr = server.address() as AddressInfo;
      const actualPort = addr?.port ?? port;
      console.log(`OpenCode Plugin Chat: http://localhost:${actualPort}`);
      console.log(`Workshop URL: ${WORKSHOP_BASE}`);
      resolve({
        port: actualPort,
        close: () => new Promise<void>((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

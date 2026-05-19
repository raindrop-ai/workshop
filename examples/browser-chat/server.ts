/**
 * Browser SDK example — events-only.
 *
 * The browser uses `@raindrop-ai/browser-sdk`'s `trackAiPartial(begin → finish)`
 * to record one event per turn, mirrored to Workshop via `localWorkshopUrl`.
 * The server is a thin OpenAI Responses API proxy so the browser doesn't see
 * the OpenAI key. No tools, no provider-options knobs — browser-sdk has no
 * span surface and no per-call config in its public API.
 */
import express from "express";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { loadWorkspaceEnv } from "../loadEnv.ts";

loadWorkspaceEnv(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT ?? 3016);
const PUBLIC_DIR = path.join(__dirname, "public");
const WORKSHOP_URL = process.env.RAINDROP_LOCAL_DEBUGGER ?? "http://localhost:5899/v1/";
const CONVO_ID = "browser-chat-demo";
const EVENT_NAME = "browser_chat";
const USER_ID = "demo-browser-user";

const SYSTEM_PROMPT = [
  "You are a deployment-rollout planner for an enterprise SaaS team.",
  "Answer concisely in plain text.",
].join(" ");

const WORKSHOP_BASE = (() => {
  try {
    const u = new URL(WORKSHOP_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
})();

async function bundleSdk(): Promise<void> {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  await build({
    entryPoints: ["@raindrop-ai/browser-sdk"],
    absWorkingDir: __dirname,
    bundle: true,
    format: "iife",
    globalName: "RaindropBrowserSDK",
    outfile: path.join(PUBLIC_DIR, "raindrop.js"),
    platform: "browser",
    target: ["es2020"],
    logLevel: "info",
  });
}

const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop Browser SDK Chat</title>
    <link rel="icon" href="data:," />
    <style>
      body { margin: 0; font: 16px/1.4 sans-serif; }
      .container { display: flex; flex-direction: column; height: 100vh; max-width: 720px; margin: 0 auto; padding: 1.5rem; box-sizing: border-box; }
      .scrollable { flex: 1; overflow-y: auto; padding-right: .5rem; }
      .input-bar { flex-shrink: 0; padding-top: 1rem; margin-top: 1rem; border-top: 1px solid #e5e7eb; }
      h1 { margin: 0 0 .25rem; font-size: 18px; }
      textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; }
      textarea { min-height: 60px; }
      button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: white; font: inherit; cursor: pointer; }
      button:disabled { opacity: .6; cursor: wait; }
      button.secondary { background: none; color: #555; border-color: #d1d5db; margin-left: .5rem; }
      label { display: block; font-size: 12px; color: #666; margin: .5rem 0 .15rem; }
      .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem .75rem; }
      details summary { cursor: pointer; font-size: 12px; color: #666; }
      .history { margin-top: 1.25rem; display: flex; flex-direction: column; gap: .75rem; }
      .bubble { padding: .5rem .75rem; border-radius: 8px; }
      .bubble-user { background: #eff6ff; border: 1px solid #dbeafe; }
      .bubble-assistant { background: #f4f4f4; border: 1px solid #e5e7eb; }
      .bubble-role { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .25rem; }
      .bubble-content { white-space: pre-wrap; min-height: 1em; }
      .bubble-link { display: block; margin-top: .35rem; font-size: 11px; color: #2563eb; text-decoration: none; }
      .bubble-link:hover { text-decoration: underline; }
      .actions { display: flex; align-items: center; margin-top: .5rem; }
      .status { margin-left: .75rem; font-size: 13px; color: #666; }
      .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #2563eb; margin-right: .35rem; vertical-align: middle; animation: pulse 1s infinite; }
      @keyframes pulse { 50% { opacity: .25; } }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="scrollable" id="scrollable">
        <h1>Browser SDK Chat</h1>
        <p>Each turn is one <code>trackAiPartial(begin → finish)</code> event mirrored to Workshop. No span tree (browser-sdk is events-only).</p>

        <details open>
          <summary>System prompt</summary>
          <textarea id="system" rows="5">${SYSTEM_PROMPT}</textarea>
        </details>

        <div class="row">
          <div><label>Model</label><input id="model" placeholder="gpt-5.4-mini" /></div>
          <div><label>Temperature</label><input id="temperature" type="number" min="0" max="2" step="0.1" value="0.4" /></div>
          <div><label>Max output tokens</label><input id="maxOutputTokens" type="number" min="1" /></div>
        </div>

        <div id="history" class="history"></div>
      </div>

      <div class="input-bar">
        <textarea id="prompt" placeholder="Type a message. Cmd/Ctrl+Enter to send. Knobs apply to the next turn.">Plan the next deployment rollout for enterprise customer userId cust-acme-001 (topic: "checkout v2 cutover").</textarea>
        <div class="actions">
          <button id="send">Send</button>
          <button id="reset" class="secondary">Reset</button>
          <span id="status" class="status" hidden></span>
        </div>
      </div>
    </div>

    <script src="/raindrop.js"></script>
    <script>
      const $ = (id) => document.getElementById(id);
      const num = (id) => $(id).value === "" ? null : Number($(id).value);
      const str = (id) => $(id).value || null;
      const FOOTER_RE = /\\n\\n\u2192 Open in Workshop: (\\S+)\\s*$/;
      const statusEl = $("status");
      const historyEl = $("history");
      const scrollableEl = $("scrollable");
      const messages = [];

      const r = new RaindropBrowserSDK.Raindrop({ localWorkshopUrl: "${WORKSHOP_URL}" });

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

      $("reset").onclick = () => {
        if ($("send").disabled) return;
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

        const eventId = crypto.randomUUID();
        const partial = await r.trackAiPartial({
          event: "${EVENT_NAME}",
          userId: "${USER_ID}",
          convoId: "${CONVO_ID}",
          eventId,
          input: userText,
        });

        $("send").disabled = true;
        setStatus("Waiting for first chunk\u2026");
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: messages.slice(0, asstIdx),
              system: $("system").value,
              model: str("model"),
              temperature: num("temperature"),
              maxOutputTokens: num("maxOutputTokens"),
            }),
          });
          if (!res.ok) {
            const errText = "[error] " + res.status + " " + res.statusText + ": " + (await res.text());
            messages[asstIdx].content = errText;
            await partial.finish({ event: "${EVENT_NAME}", userId: "${USER_ID}", convoId: "${CONVO_ID}", output: errText });
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
            if (firstChunk) { setStatus("Streaming\u2026"); firstChunk = false; }
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
          await partial.finish({
            event: "${EVENT_NAME}",
            userId: "${USER_ID}",
            convoId: "${CONVO_ID}",
            output: messages[asstIdx].content,
          });
          // Server proxies the convo lookup since Workshop's /api/* isn't CORS-enabled.
          try {
            const r = await fetch("/api/workshop-link?eventId=" + encodeURIComponent(eventId));
            if (r.ok) {
              const data = await r.json();
              if (data.url) {
                messages[asstIdx].workshopUrl = data.url;
                renderHistory();
              }
            }
          } catch {}
        } finally {
          $("send").disabled = false;
          setStatus("");
        }
      };
    </script>
  </body>
</html>`;

async function streamOpenAi(
  messages: Array<{ role: string; content: string }>,
  system: string,
  model: string,
  temperature: number | null,
  maxOutputTokens: number | null,
): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const body: Record<string, unknown> = {
    model,
    input: [{ role: "system", content: system }, ...messages],
    stream: true,
  };
  if (temperature != null) body.temperature = temperature;
  if (maxOutputTokens != null) body.max_output_tokens = maxOutputTokens;
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function startServer(port = DEFAULT_PORT) {
  await bundleSdk();
  const app = express();
  app.use(express.json());
  app.get("/", (_req, res) => res.type("html").send(HTML));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/workshop-link", async (req, res) => {
    const eventId = typeof req.query.eventId === "string" ? req.query.eventId : "";
    if (!eventId || !WORKSHOP_BASE) {
      res.json({ url: null });
      return;
    }
    for (let i = 0; i < 10; i++) {
      try {
        const rows = (await (await fetch(`${WORKSHOP_BASE}/api/convo/${CONVO_ID}`)).json()) as Array<{
          id: string;
          event_id?: string;
        }>;
        const hit = rows.find((r) => r.event_id === eventId);
        if (hit) {
          res.json({ url: `${WORKSHOP_BASE}/runs/${encodeURIComponent(hit.id)}` });
          return;
        }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    res.json({ url: null });
  });

  app.post("/api/chat", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    if (incoming.length === 0) {
      res.status(400).type("text/plain").send("messages array is required");
      return;
    }
    const requestedModel =
      (typeof body.model === "string" && body.model) || process.env.OPENAI_MODEL || "gpt-5.4-mini";
    const systemPrompt =
      typeof body.system === "string" && body.system ? body.system : SYSTEM_PROMPT;
    const temperature =
      typeof body.temperature === "number" && Number.isFinite(body.temperature)
        ? body.temperature
        : null;
    const maxOutputTokens =
      typeof body.maxOutputTokens === "number" && Number.isFinite(body.maxOutputTokens)
        ? body.maxOutputTokens
        : null;

    let upstream: Response;
    try {
      upstream = await streamOpenAi(
        incoming as any,
        systemPrompt,
        requestedModel,
        temperature,
        maxOutputTokens,
      );
    } catch (err) {
      res.status(500).type("text/plain").send(`upstream error: ${(err as Error).message}`);
      return;
    }
    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      res.status(502).type("text/plain").send(`upstream ${upstream.status}: ${errText.slice(0, 500)}`);
      return;
    }

    res.type("text/plain; charset=utf-8");
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (event === "response.output_text.delta" && data) {
          try {
            const parsed = JSON.parse(data);
            if (typeof parsed.delta === "string") res.write(parsed.delta);
          } catch {}
        }
      }
    }
    res.end();
  });

  return new Promise<{ port: number }>((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`Browser SDK Chat: http://localhost:${actualPort}`);
      console.log(`Workshop URL:     ${WORKSHOP_URL}`);
      resolve({ port: actualPort });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startServer();
}

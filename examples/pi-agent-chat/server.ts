import { randomUUID } from "node:crypto";
import type { Server } from "http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, getModel, type Static } from "@mariozechner/pi-ai";
import { createRaindropPiAgent, type RaindropPiAgentClient } from "@raindrop-ai/pi-agent";
import express from "express";
import type { Express } from "express";
import { loadWorkspaceEnv } from "../loadEnv.ts";

loadWorkspaceEnv(import.meta.url);

const DEFAULT_PORT = Number(process.env.PORT ?? 3020);
const DEFAULT_PROVIDER = "openai" as const;
const DEFAULT_MODEL_ID = "gpt-4o-mini";
const CONVO_ID = "pi-agent-demo";
const EVENT_NAME = "pi_agent_chat";
const USER_ID = "example-user";

const SYSTEM_PROMPT = [
  "You are a deployment-rollout planner for an enterprise SaaS team.",
  "Use every tool you have access to (each at most once) to gather context, then write the final execution plan.",
  "Always answer in plain text.",
].join(" ");

const USER_ID_PARAM = Type.Object({ userId: Type.String() });
const QUERY_PARAM = Type.Object({ query: Type.String() });
const TOPIC_PARAM = Type.Object({ topic: Type.String() });

const LOAD_CUSTOMER_PROFILE: AgentTool<typeof USER_ID_PARAM> = {
  name: "load_customer_profile",
  label: "Load customer profile",
  description: "Load account metadata for the current customer.",
  parameters: USER_ID_PARAM,
  execute: async (_id, params: Static<typeof USER_ID_PARAM>) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          userId: params.userId,
          tier: "enterprise",
          activeDeployments: 3,
          stakeholders: ["ops", "security", "support"],
        }),
      },
    ],
    details: {},
  }),
};

const SEARCH_DOCS: AgentTool<typeof QUERY_PARAM> = {
  name: "search_docs",
  label: "Search docs",
  description: "Search docs for relevant rollout guidance.",
  parameters: QUERY_PARAM,
  execute: async (_id, params: Static<typeof QUERY_PARAM>) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify([
          `Runbook note for ${params.query}: stage traffic shifts.`,
          `Checklist note for ${params.query}: capture operator summary.`,
          `Audit note for ${params.query}: persist tool evidence.`,
        ]),
      },
    ],
    details: {},
  }),
};

const SLOW_POLICY_SCAN: AgentTool<typeof TOPIC_PARAM> = {
  name: "slow_policy_scan",
  label: "Slow policy scan",
  description: "Perform a longer compliance scan before rollout.",
  parameters: TOPIC_PARAM,
  execute: async (_id, params: Static<typeof TOPIC_PARAM>) => {
    await new Promise((r) => setTimeout(r, 350));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            topic: params.topic,
            requiredChecks: ["security-review", "audit-export", "support-brief"],
          }),
        },
      ],
      details: {},
    };
  },
};

const DELEGATE_RESEARCH_AGENT: AgentTool<typeof TOPIC_PARAM> = {
  name: "delegate_research_agent",
  label: "Delegate research agent",
  description:
    "Run a delegated research sub-agent that investigates the topic and returns a ranked summary.",
  parameters: TOPIC_PARAM,
  execute: async (_id, params: Static<typeof TOPIC_PARAM>) => {
    const snippets = [
      `Snippet A about ${params.topic}: operators need a short handoff.`,
      `Snippet B about ${params.topic}: audits fail when context is fragmented.`,
      `Snippet C about ${params.topic}: long-running checks should happen before rollout.`,
    ];
    const ranking = snippets.map((finding, index) => ({ finding, priority: index + 1 }));
    return {
      content: [{ type: "text", text: JSON.stringify({ snippets, ranking }) }],
      details: {},
    };
  },
};

const TOOLS: AgentTool[] = [
  LOAD_CUSTOMER_PROFILE,
  SEARCH_DOCS,
  SLOW_POLICY_SCAN,
  DELEGATE_RESEARCH_AGENT,
];

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

async function resolveWorkshopRunUrl(startedAfter: number): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const rows = (await (await fetch(`${WORKSHOP_BASE}/api/convo/${CONVO_ID}`)).json()) as Array<{
        id: string;
        started_at?: number;
      }>;
      const hit = rows.find((r) => (r.started_at ?? 0) >= startedAfter);
      if (hit) return `${WORKSHOP_BASE}/runs/${encodeURIComponent(hit.id)}`;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop Pi Agent Chat</title>
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
      .row { display: grid; grid-template-columns: repeat(2, 1fr); gap: .5rem .75rem; }
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
        <h1>Pi Agent + Raindrop</h1>
        <p>@mariozechner/pi-agent-core driven by @mariozechner/pi-ai, instrumented via <code>createRaindropPiAgent</code>. Each turn opens a Raindrop event with one LLM span and a tool span per tool call; the four synthetic tools (<code>load_customer_profile</code>, <code>search_docs</code>, <code>slow_policy_scan</code>, <code>delegate_research_agent</code>) match the ai-sdk-chat example so Workshop runs are comparable side-by-side.</p>

        <details open>
          <summary>System prompt</summary>
          <textarea id="system" rows="5">${SYSTEM_PROMPT}</textarea>
        </details>

        <div class="row">
          <div><label>Provider</label><input id="provider" placeholder="${DEFAULT_PROVIDER}" /></div>
          <div><label>Model</label><input id="model" placeholder="${DEFAULT_MODEL_ID}" /></div>
        </div>
        <p style="font-size: 11px; color: #888; margin: .5rem 0 0;">Provider/model must be one supported by <code>@mariozechner/pi-ai::getModel(provider, modelId)</code>. Pi Agent picks up provider API keys from the same env vars OpenAI/Anthropic SDKs use.</p>

        <div id="history" class="history"></div>
      </div>

      <div class="input-bar">
        <textarea id="prompt" placeholder="Type a message. Cmd/Ctrl+Enter to send. Reset clears the agent's transcript.">Plan the next deployment rollout for enterprise customer userId cust-acme-001 (topic: "checkout v2 cutover"). Use every tool available to gather context first.</textarea>
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
        setStatus("Waiting for first chunk\u2026");
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: userText,
              system: $("system").value,
              provider: str("provider"),
              model: str("model"),
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
  system?: string | null;
  provider?: string | null;
  model?: string | null;
}

interface AgentSession {
  agent: Agent;
  raindrop: RaindropPiAgentClient;
  unsubscribeRaindrop: () => void;
}

let session: AgentSession | null = null;
let currentSystemPrompt = SYSTEM_PROMPT;
let currentProvider = DEFAULT_PROVIDER as string;
let currentModelId = DEFAULT_MODEL_ID as string;

function buildSession(provider: string, modelId: string, systemPrompt: string): AgentSession {
  const model = getModel(provider as Parameters<typeof getModel>[0], modelId as never);
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: TOOLS,
    },
    sessionId: randomUUID(),
  });
  const raindrop = createRaindropPiAgent({
    writeKey: process.env.RAINDROP_WRITE_KEY ?? undefined,
    userId: USER_ID,
    convoId: CONVO_ID,
    eventName: EVENT_NAME,
    properties: {
      example: "pi-agent-chat",
    },
  });
  const unsubscribeRaindrop = raindrop.subscribe(agent);
  return { agent, raindrop, unsubscribeRaindrop };
}

async function teardownSession(s: AgentSession): Promise<void> {
  s.unsubscribeRaindrop();
  await s.raindrop.shutdown();
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

    const provider = body.provider?.trim() || currentProvider;
    const modelId = body.model?.trim() || currentModelId;
    const systemPrompt = body.system?.trim() || currentSystemPrompt;

    const knobsChanged =
      session === null ||
      provider !== currentProvider ||
      modelId !== currentModelId ||
      systemPrompt !== currentSystemPrompt;
    if (knobsChanged) {
      if (session) {
        await teardownSession(session).catch(() => {});
        session = null;
      }
      try {
        session = buildSession(provider, modelId, systemPrompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).type("text/plain").send(`failed to build agent: ${msg}`);
        return;
      }
      currentProvider = provider;
      currentModelId = modelId;
      currentSystemPrompt = systemPrompt;
    }

    const active = session;
    if (!active) {
      res.status(500).type("text/plain").send("no active session");
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    const startedAt = Date.now();
    let firstChunkSeen = false;
    const unsubscribeStream = active.agent.subscribe((event) => {
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type === "text_delta") {
        firstChunkSeen = true;
        try {
          res.write(event.assistantMessageEvent.delta);
        } catch {
          // client disconnected; let agent.prompt() drain on its own
        }
      }
    });

    try {
      await active.agent.prompt(userInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (firstChunkSeen) {
        res.write(`\n\n[error] ${msg}`);
      } else {
        res.write(`[error] ${msg}`);
      }
    } finally {
      unsubscribeStream();
    }

    const workshopUrl = await resolveWorkshopRunUrl(startedAt);
    if (workshopUrl) {
      res.write(`\n\n→ Open in Workshop: ${workshopUrl}`);
    }
    res.end();
  });

  app.post("/api/reset", async (_req, res) => {
    if (session) {
      await teardownSession(session).catch(() => {});
      session = null;
    }
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
      console.log(`Pi Agent SDK Chat: http://localhost:${actualPort}`);
      console.log(`Workshop URL: ${WORKSHOP_BASE}`);
      resolve({
        port: actualPort,
        close: async () => {
          if (session) {
            await teardownSession(session).catch(() => {});
            session = null;
          }
          await new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          });
        },
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

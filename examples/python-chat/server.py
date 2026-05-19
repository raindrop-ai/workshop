"""Raindrop python-chat example.

aiohttp + OpenAI + raindrop-ai (Python). Manual tool-loop wired through
``interaction.track_tool`` so the example exercises both the partial-event
endpoint (``begin → finish``) and the trace endpoint (tool spans).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import aiohttp
from aiohttp import web
from openai import AsyncOpenAI


def _load_workspace_env() -> None:
    """Walk parent directories looking for ``.env`` / ``.env.local``.

    Mirrors `examples/loadEnv.ts` so the Python example sources `OPENAI_API_KEY`
    the same way as the TS examples when run via `bun run dev:examples`
    OR standalone from any subdirectory. Iterates root → leaf so that a
    closer `.env` overrides one further up the tree (matches TS semantics).
    """
    initial = set(os.environ.keys())
    dirs: list[Path] = []
    seen: set[Path] = set()
    here = Path(__file__).resolve().parent
    for start in (Path.cwd().resolve(), here):
        # Build the list root → leaf so dirs closer to the example win.
        for parent in reversed([start, *start.parents]):
            if parent in seen:
                continue
            seen.add(parent)
            dirs.append(parent)
    for parent in dirs:
        for name in (".env", ".env.local"):
            fp = parent / name
            if not fp.is_file():
                continue
            for raw in fp.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                eq = line.find("=")
                if eq <= 0:
                    continue
                key = line[:eq].strip()
                if not key or key in initial:
                    continue
                val = line[eq + 1 :].strip()
                # Require len >= 2 so a degenerate value like `"` (a lone
                # quote) doesn't pass both startswith/endswith on the same
                # character and silently slice down to an empty string.
                if len(val) >= 2 and (
                    (val.startswith('"') and val.endswith('"'))
                    or (val.startswith("'") and val.endswith("'"))
                ):
                    val = val[1:-1]
                os.environ[key] = val


_load_workspace_env()

import raindrop.analytics as raindrop  # noqa: E402

DEFAULT_PORT = int(os.getenv("PORT", "3017"))
CONVO_ID = "python-demo"
EVENT_NAME = "python_chat"
USER_ID = "example-user"

SYSTEM_PROMPT = (
    "You are a deployment-rollout planner for an enterprise SaaS team. "
    "Use every tool you have access to (each at most once) to gather context, "
    "then write the final execution plan. Always answer in plain text."
)

raindrop.init(
    api_key=os.getenv("RAINDROP_WRITE_KEY") or None,
    tracing_enabled=True,
    bypass_otel_for_tools=True,
    auto_instrument=False,
)


def _workshop_base() -> str:
    raw = raindrop.local_workshop_url or ""
    if not raw:
        return ""
    try:
        u = urlparse(raw)
        return f"{u.scheme}://{u.netloc}"
    except Exception:
        return ""


WORKSHOP_BASE = _workshop_base()


async def resolve_workshop_run_url(started_after_ms: int) -> str | None:
    """Poll Workshop for a run that landed after ``started_after_ms``.

    The Workshop daemon assigns a ``run.id`` server-side; this lookup mirrors
    the TS examples' deep-link helper so each turn ends with a clickable link.
    """
    if not WORKSHOP_BASE:
        return None
    url = f"{WORKSHOP_BASE}/api/convo/{CONVO_ID}"
    timeout = aiohttp.ClientTimeout(total=2.0)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for _ in range(10):
            try:
                async with session.get(url) as r:
                    rows = await r.json()
                if isinstance(rows, list):
                    for row in rows:
                        if (row.get("started_at") or 0) >= started_after_ms:
                            return f"{WORKSHOP_BASE}/runs/{quote(str(row['id']), safe='')}"
            except Exception:
                pass
            await asyncio.sleep(0.2)
    return None


HTML = """<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop Python Chat</title>
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
        <h1>Python SDK Chat</h1>
        <p>aiohttp + OpenAI + raindrop-ai (Python) with manual <code>interaction.track_tool</code> spans.</p>

        <details open>
          <summary>System prompt</summary>
          <textarea id="system" rows="5">__SYSTEM_PROMPT__</textarea>
        </details>

        <div class="row">
          <div><label>Model</label><input id="model" placeholder="gpt-5.4-mini" /></div>
          <div><label>Temperature</label><input id="temperature" type="number" min="0" max="2" step="0.1" value="0.4" /></div>
          <div><label>Top P</label><input id="topP" type="number" min="0" max="1" step="0.05" /></div>
          <div><label>Max output tokens</label><input id="maxOutputTokens" type="number" min="1" /></div>
          <div><label>Seed</label><input id="seed" type="number" /></div>
          <div><label>Max steps</label><input id="maxSteps" type="number" min="1" value="10" /></div>
          <div>
            <label>Tools</label>
            <select id="useTools">
              <option value="1" selected>on</option>
              <option value="0">off (single LLM call)</option>
            </select>
          </div>
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

    <script>
      const $ = (id) => document.getElementById(id);
      const num = (id) => $(id).value === "" ? null : Number($(id).value);
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
              topP: num("topP"),
              maxOutputTokens: num("maxOutputTokens"),
              seed: num("seed"),
              maxSteps: num("maxSteps"),
              useTools: $("useTools").value === "1",
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
</html>
""".replace("__SYSTEM_PROMPT__", SYSTEM_PROMPT)


TOOL_DEFS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "load_customer_profile",
            "description": "Load account metadata for the current customer.",
            "parameters": {
                "type": "object",
                "properties": {"userId": {"type": "string"}},
                "required": ["userId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_docs",
            "description": "Search docs for relevant rollout guidance.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "slow_policy_scan",
            "description": "Perform a longer compliance scan before rollout.",
            "parameters": {
                "type": "object",
                "properties": {"topic": {"type": "string"}},
                "required": ["topic"],
            },
        },
    },
]


async def run_tool(name: str, args: dict[str, Any]) -> Any:
    if name == "load_customer_profile":
        return {
            "userId": args.get("userId"),
            "tier": "enterprise",
            "activeDeployments": 3,
            "stakeholders": ["ops", "security", "support"],
        }
    if name == "search_docs":
        q = args.get("query")
        return [
            f"Runbook note for {q}: stage traffic shifts.",
            f"Checklist note for {q}: capture operator summary.",
            f"Audit note for {q}: persist tool evidence.",
        ]
    if name == "slow_policy_scan":
        await asyncio.sleep(0.35)
        return {
            "topic": args.get("topic"),
            "requiredChecks": ["security-review", "audit-export", "support-brief"],
        }
    return {"error": f"Unknown tool: {name}"}


def _index(_request: web.Request) -> web.Response:
    return web.Response(text=HTML, content_type="text/html")


def _chat_call_kwargs(body: dict[str, Any], model: str, use_tools: bool) -> dict[str, Any]:
    kw: dict[str, Any] = {"model": model, "stream": True}
    for src, dst in (
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("maxOutputTokens", "max_completion_tokens"),
        ("seed", "seed"),
    ):
        v = body.get(src)
        if isinstance(v, (int, float)):
            kw[dst] = v
    if use_tools:
        kw["tools"] = TOOL_DEFS
    return kw


async def chat_handler(request: web.Request) -> web.StreamResponse:
    body = await request.json() if request.can_read_body else {}
    incoming = body.get("messages") or []
    if not isinstance(incoming, list) or not incoming:
        return web.Response(status=400, text="messages array is required")

    openai_client: AsyncOpenAI | None = request.app.get("openai_client")
    if openai_client is None:
        return web.Response(status=500, text="OPENAI_API_KEY is required")

    system_prompt = body.get("system") or SYSTEM_PROMPT
    use_tools = bool(body.get("useTools", True))
    max_steps = body.get("maxSteps")
    if not isinstance(max_steps, int) or max_steps < 1:
        max_steps = 10
    requested_model = body.get("model") or os.getenv("OPENAI_MODEL") or "gpt-5.4-mini"

    last_user = next((m for m in reversed(incoming) if m.get("role") == "user"), None)
    interaction = raindrop.begin(
        user_id=USER_ID,
        event=EVENT_NAME,
        event_id=str(uuid.uuid4()),
        convo_id=CONVO_ID,
        input=(last_user or {}).get("content", ""),
    )
    finished = False

    res = web.StreamResponse(status=200, headers={"Content-Type": "text/plain; charset=utf-8"})
    await res.prepare(request)

    started_at_ms = int(time.time() * 1000)
    final_text = ""
    client = openai_client

    try:
        msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}, *incoming]
        for _ in range(max_steps):
            stream = await client.chat.completions.create(
                messages=msgs,
                **_chat_call_kwargs(body, requested_model, use_tools),
            )

            text_out = ""
            tool_calls: list[dict[str, str]] = []
            async for chunk in stream:
                choice = chunk.choices[0] if chunk.choices else None
                delta = getattr(choice, "delta", None) if choice else None
                if not delta:
                    continue
                if delta.content:
                    text_out += delta.content
                    await res.write(delta.content.encode("utf-8"))
                for tc in delta.tool_calls or []:
                    while len(tool_calls) <= tc.index:
                        tool_calls.append({"id": "", "name": "", "args": ""})
                    if tc.id:
                        tool_calls[tc.index]["id"] = tc.id
                    if tc.function and tc.function.name:
                        tool_calls[tc.index]["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        tool_calls[tc.index]["args"] += tc.function.arguments

            if not tool_calls:
                final_text = text_out
                break

            msgs.append({
                "role": "assistant",
                "content": text_out or None,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["args"]},
                    }
                    for tc in tool_calls
                ],
            })

            for tc in tool_calls:
                try:
                    parsed_args = json.loads(tc["args"] or "{}")
                except json.JSONDecodeError:
                    parsed_args = {}
                t0 = time.time()
                try:
                    result = await run_tool(tc["name"], parsed_args)
                    interaction.track_tool(
                        name=tc["name"],
                        input=parsed_args,
                        output=result,
                        duration_ms=(time.time() - t0) * 1000,
                    )
                except Exception as exc:
                    result = {"error": str(exc)}
                    interaction.track_tool(
                        name=tc["name"],
                        input=parsed_args,
                        duration_ms=(time.time() - t0) * 1000,
                        error=exc,
                    )
                msgs.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": json.dumps(result),
                })

        # The Python SDK's `finish()` doesn't expose a `model` kwarg
        # (PartialTrackAIEvent rejects extras and the `ai_data` it builds
        # only carries `output`). Record model as a top-level property so
        # it still shows up in the Workshop run detail.
        interaction.set_properties({"model": requested_model})
        interaction.finish(output=final_text or "(no output)")
        finished = True
        # Force partials + tool spans to flush before we look up the run id.
        raindrop.flush()
        url = await resolve_workshop_run_url(started_at_ms)
        if url:
            try:
                await res.write(f"\n\n→ Open in Workshop: {url}\n".encode("utf-8"))
            except (ConnectionResetError, asyncio.CancelledError):
                pass
    except Exception as exc:
        if not finished:
            interaction.set_properties({"model": requested_model})
            interaction.finish(output=f"Error: {exc}")
            finished = True
        try:
            await res.write(f"\n\n[error] {exc}\n".encode("utf-8"))
        except (ConnectionResetError, asyncio.CancelledError):
            pass
    finally:
        try:
            await res.write_eof()
        except (ConnectionResetError, asyncio.CancelledError):
            pass

    return res


async def _close_openai_client(app: web.Application) -> None:
    client = app.get("openai_client")
    if client is not None:
        await client.close()


def make_app() -> web.Application:
    app = web.Application()
    api_key = os.environ.get("OPENAI_API_KEY")
    # Hoist the OpenAI client to app-level so the underlying httpx
    # connection pool is reused across requests instead of leaking a
    # fresh pool per chat turn.
    if api_key:
        app["openai_client"] = AsyncOpenAI(api_key=api_key)
        app.on_cleanup.append(_close_openai_client)
    app.router.add_get("/", _index)
    app.router.add_post("/api/chat", chat_handler)
    return app


def main() -> None:
    app = make_app()
    print(f"Python SDK chat: http://localhost:{DEFAULT_PORT}")
    if WORKSHOP_BASE:
        print(f"Workshop base : {WORKSHOP_BASE}")
    web.run_app(app, host="127.0.0.1", port=DEFAULT_PORT, print=None)


if __name__ == "__main__":
    main()

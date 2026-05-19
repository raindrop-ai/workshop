//! Raindrop rust-chat example.
//!
//! axum + reqwest + raindrop-ai (Rust) + OpenAI. Mirrors the unified chat UX
//! used by the TypeScript examples (pinned-bottom input, multi-turn bubbles,
//! Cmd/Ctrl+Enter, knobs, Workshop deep-link footer) and demos
//! `Client::begin → Interaction::finish` plus `interaction.track_tool` so
//! tool spans land as `TOOL_CALL` rows in Workshop's `spans` table.

use std::convert::Infallible;
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use futures::StreamExt;
use raindrop::{
    resolve_local_workshop_url, BeginOptions, Client, FinishOptions, LocalWorkshopUrlConfig,
    TrackToolOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use uuid::Uuid;

const DEFAULT_PORT: u16 = 3018;
const CONVO_ID: &str = "rust-demo";
const EVENT_NAME: &str = "rust_chat";
const USER_ID: &str = "example-user";
const SYSTEM_PROMPT: &str = "You are a deployment-rollout planner for an enterprise SaaS team. Use every tool you have access to (each at most once) to gather context, then write the final execution plan. Always answer in plain text.";

const HTML: &str = r##"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop Rust Chat</title>
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
        <h1>Rust SDK Chat</h1>
        <p>axum + reqwest + raindrop-ai (Rust) with manual <code>interaction.track_tool</code> spans.</p>

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
      const FOOTER_RE = /\n\n\u2192 Open in Workshop: (\S+)\s*$/;
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
"##;

#[derive(Clone)]
struct AppState {
    raindrop: Arc<Client>,
    openai_key: Option<String>,
    openai_model_default: String,
    workshop_base: String,
}

#[derive(Deserialize)]
struct ChatRequest {
    messages: Vec<ChatMessage>,
    #[serde(default)]
    system: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default, rename = "topP")]
    top_p: Option<f64>,
    #[serde(default, rename = "maxOutputTokens")]
    max_output_tokens: Option<i64>,
    #[serde(default)]
    seed: Option<i64>,
    #[serde(default, rename = "maxSteps")]
    max_steps: Option<i64>,
    #[serde(default = "default_use_tools", rename = "useTools")]
    use_tools: bool,
}

fn default_use_tools() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "tool_calls")]
    tool_calls: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "tool_call_id")]
    tool_call_id: Option<String>,
}

/// Walk parent directories looking for `.env` / `.env.local` and load
/// any `KEY=value` lines into `env`. Mirrors `examples/loadEnv.ts` so the
/// Rust example sources `OPENAI_API_KEY` the same way as the TS examples
/// when run via `bun run dev:examples` OR standalone from any subdir.
/// Iterates root → leaf so dirs closer to the example win, but the
/// initial process env always wins so callers can still override with
/// `OPENAI_API_KEY=… cargo run`.
fn load_workspace_env() {
    let initial: std::collections::HashSet<String> = std::env::vars().map(|(k, _)| k).collect();
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    let here = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let cwd = std::env::current_dir().unwrap_or_else(|_| here.clone());
    for start in [&cwd, &here] {
        let mut chain: Vec<std::path::PathBuf> = vec![start.clone()];
        let mut p: &std::path::Path = start.as_path();
        while let Some(parent) = p.parent() {
            chain.push(parent.to_path_buf());
            p = parent;
        }
        for d in chain.into_iter().rev() {
            if seen.insert(d.clone()) {
                dirs.push(d);
            }
        }
    }
    for dir in &dirs {
        for name in [".env", ".env.local"] {
            let fp = dir.join(name);
            let Ok(contents) = std::fs::read_to_string(&fp) else { continue };
            for raw in contents.lines() {
                let mut line = raw.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some(rest) = line.strip_prefix("export ") {
                    line = rest.trim();
                }
                let Some((key, val)) = line.split_once('=') else { continue };
                let key = key.trim();
                if key.is_empty() || initial.contains(key) {
                    continue;
                }
                let mut val = val.trim();
                if val.len() >= 2
                    && ((val.starts_with('"') && val.ends_with('"'))
                        || (val.starts_with('\'') && val.ends_with('\'')))
                {
                    val = &val[1..val.len() - 1];
                }
                std::env::set_var(key, val);
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    load_workspace_env();

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let workshop_url = resolve_local_workshop_url(&LocalWorkshopUrlConfig::Inherit, true);
    let workshop_base = workshop_url
        .as_deref()
        .and_then(|u| u.parse::<reqwest::Url>().ok())
        .map(|u| {
            let port = u.port().map(|p| format!(":{}", p)).unwrap_or_default();
            format!("{}://{}{}", u.scheme(), u.host_str().unwrap_or("localhost"), port)
        })
        .unwrap_or_default();

    let raindrop = Client::builder()
        .write_key(env::var("RAINDROP_WRITE_KEY").unwrap_or_default())
        .build()?;

    let state = AppState {
        raindrop: Arc::new(raindrop),
        openai_key: env::var("OPENAI_API_KEY").ok(),
        openai_model_default: env::var("OPENAI_MODEL")
            .unwrap_or_else(|_| "gpt-5.4-mini".to_string()),
        workshop_base: workshop_base.clone(),
    };

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/api/chat", post(chat_handler))
        .with_state(state.clone());

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    println!("Rust SDK chat: http://localhost:{}", port);
    if !workshop_base.is_empty() {
        println!("Workshop base : {}", workshop_base);
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let serve = axum::serve(listener, app.into_make_service());
    let raindrop_for_shutdown = Arc::clone(&state.raindrop);
    tokio::select! {
        result = serve => result?,
        _ = tokio::signal::ctrl_c() => {
            // Drain partial events + tool spans before exit so the last turn
            // shows up in Workshop's run list.
            let _ = raindrop_for_shutdown.flush().await;
        }
    }
    Ok(())
}

async fn index_handler() -> Html<String> {
    Html(HTML.replace("__SYSTEM_PROMPT__", SYSTEM_PROMPT))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn chat_handler(State(state): State<AppState>, Json(req): Json<ChatRequest>) -> Response {
    if req.messages.is_empty() {
        return (StatusCode::BAD_REQUEST, "messages array is required").into_response();
    }
    let Some(openai_key) = state.openai_key.clone() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "OPENAI_API_KEY is required").into_response();
    };

    let last_user_input = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .and_then(|m| m.content.as_ref())
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let model = req
        .model
        .clone()
        .unwrap_or_else(|| state.openai_model_default.clone());
    let max_steps = req.max_steps.filter(|n| *n > 0).unwrap_or(10);
    let event_id = Uuid::new_v4().to_string();
    let started_at_ms = now_ms();

    let interaction = state
        .raindrop
        .begin(BeginOptions {
            event_id: event_id.clone(),
            user_id: USER_ID.into(),
            event: EVENT_NAME.into(),
            input: last_user_input,
            model: model.clone(),
            convo_id: CONVO_ID.into(),
            ..Default::default()
        })
        .await;

    let (tx, rx) = mpsc::unbounded_channel::<Result<Bytes, Infallible>>();
    let body = Body::from_stream(UnboundedReceiverStream::new(rx));

    let workshop_base = state.workshop_base.clone();
    let raindrop = Arc::clone(&state.raindrop);
    let system_prompt = req.system.clone().unwrap_or_else(|| SYSTEM_PROMPT.into());
    let req_clone = req;

    tokio::spawn(async move {
        let result = run_chat_loop(
            &openai_key,
            &model,
            &system_prompt,
            &req_clone,
            max_steps,
            &interaction,
            &tx,
        )
        .await;

        let final_output = match result {
            Ok(text) => text,
            Err(err) => {
                let msg = format!("\n\n[error] {}\n", err);
                let _ = tx.send(Ok(Bytes::from(msg.clone())));
                format!("Error: {}", err)
            }
        };
        let _ = interaction
            .finish(FinishOptions {
                output: final_output,
                ..Default::default()
            })
            .await;

        // Best-effort flush of buffered partial events + tool spans.
        // Bound this with a timeout: `Client::flush()` can hang indefinitely
        // on the mirror-task drain when the local Workshop’s response keeps
        // a keepalive socket open past the per-request budget. Without a cap
        // here, the chat response stream would never reach the
        // "Open in Workshop:" footer and the example UI would never render
        // the `.bubble-link` element the e2e tests assert on.
        // The Workshop’s `/api/convo/...` lookup below has its own retry
        // loop, so we don’t actually need flush to complete — background
        // POSTs will still land within a few hundred ms.
        let _ = tokio::time::timeout(Duration::from_secs(2), raindrop.flush()).await;

        if let Some(url) = resolve_workshop_run_url(&workshop_base, started_at_ms).await {
            let footer = format!("\n\n→ Open in Workshop: {}\n", url);
            let _ = tx.send(Ok(Bytes::from(footer)));
        }
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn run_chat_loop(
    openai_key: &str,
    model: &str,
    system_prompt: &str,
    req: &ChatRequest,
    max_steps: i64,
    interaction: &raindrop::Interaction,
    tx: &mpsc::UnboundedSender<Result<Bytes, Infallible>>,
) -> Result<String, String> {
    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: "system".into(),
        content: Some(Value::String(system_prompt.into())),
        tool_calls: None,
        tool_call_id: None,
    }];
    messages.extend(req.messages.iter().cloned());

    let http = reqwest::Client::new();
    let mut final_text = String::new();

    for _ in 0..max_steps {
        let mut body = serde_json::Map::new();
        body.insert("model".into(), Value::String(model.into()));
        body.insert("stream".into(), Value::Bool(true));
        body.insert("messages".into(), serde_json::to_value(&messages).unwrap());
        if let Some(v) = req.temperature {
            body.insert("temperature".into(), json!(v));
        }
        if let Some(v) = req.top_p {
            body.insert("top_p".into(), json!(v));
        }
        if let Some(v) = req.max_output_tokens {
            body.insert("max_completion_tokens".into(), json!(v));
        }
        if let Some(v) = req.seed {
            body.insert("seed".into(), json!(v));
        }
        if req.use_tools {
            body.insert("tools".into(), tool_defs());
        }

        let resp = http
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(openai_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("openai request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("openai returned {}: {}", status, text));
        }

        let StreamResult {
            text,
            tool_calls,
        } = consume_openai_stream(resp, tx).await?;

        if tool_calls.is_empty() {
            final_text = text;
            break;
        }

        messages.push(ChatMessage {
            role: "assistant".into(),
            content: if text.is_empty() {
                None
            } else {
                Some(Value::String(text))
            },
            tool_calls: Some(
                tool_calls
                    .iter()
                    .map(|tc| {
                        json!({
                            "id": tc.id,
                            "type": "function",
                            "function": { "name": tc.name, "arguments": tc.args },
                        })
                    })
                    .collect(),
            ),
            tool_call_id: None,
        });

        for tc in &tool_calls {
            let parsed_args: Value =
                serde_json::from_str(&tc.args).unwrap_or_else(|_| json!({}));
            let started = SystemTime::now();
            let result = run_tool(&tc.name, &parsed_args).await;
            let duration = started.elapsed().unwrap_or_default();

            interaction.track_tool(TrackToolOptions {
                name: tc.name.clone(),
                input: Some(parsed_args.clone()),
                output: Some(result.clone()),
                duration: Some(duration),
                ..Default::default()
            });

            messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(Value::String(result.to_string())),
                tool_calls: None,
                tool_call_id: Some(tc.id.clone()),
            });
        }
    }

    Ok(final_text)
}

struct StreamingToolCall {
    id: String,
    name: String,
    args: String,
}

struct StreamResult {
    text: String,
    tool_calls: Vec<StreamingToolCall>,
}

async fn consume_openai_stream(
    resp: reqwest::Response,
    tx: &mpsc::UnboundedSender<Result<Bytes, Infallible>>,
) -> Result<StreamResult, String> {
    let mut text = String::new();
    let mut tool_calls: Vec<StreamingToolCall> = Vec::new();
    let mut buf = Vec::<u8>::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream read error: {}", e))?;
        buf.extend_from_slice(&chunk);
        // OpenAI emits SSE: each event is `data: {...}\n\n`. Parse complete
        // events out of `buf` and leave any trailing partial in place.
        while let Some(end) = find_double_newline(&buf) {
            let event = String::from_utf8_lossy(&buf[..end]).to_string();
            buf.drain(..end + 2);
            for line in event.lines() {
                let Some(payload) = line.strip_prefix("data: ") else {
                    continue;
                };
                if payload.trim() == "[DONE]" {
                    return Ok(StreamResult { text, tool_calls });
                }
                let Ok(v) = serde_json::from_str::<Value>(payload) else {
                    continue;
                };
                let Some(delta) = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                else {
                    continue;
                };
                if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                    text.push_str(content);
                    if tx.send(Ok(Bytes::copy_from_slice(content.as_bytes()))).is_err() {
                        return Err("client disconnected".into());
                    }
                }
                if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tcs {
                        let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        while tool_calls.len() <= idx {
                            tool_calls.push(StreamingToolCall {
                                id: String::new(),
                                name: String::new(),
                                args: String::new(),
                            });
                        }
                        if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                            tool_calls[idx].id = id.to_string();
                        }
                        if let Some(func) = tc.get("function") {
                            if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                tool_calls[idx].name = name.to_string();
                            }
                            if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                tool_calls[idx].args.push_str(args);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(StreamResult { text, tool_calls })
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn tool_defs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "load_customer_profile",
                "description": "Load account metadata for the current customer.",
                "parameters": {
                    "type": "object",
                    "properties": { "userId": { "type": "string" } },
                    "required": ["userId"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_docs",
                "description": "Search docs for relevant rollout guidance.",
                "parameters": {
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "slow_policy_scan",
                "description": "Perform a longer compliance scan before rollout.",
                "parameters": {
                    "type": "object",
                    "properties": { "topic": { "type": "string" } },
                    "required": ["topic"]
                }
            }
        }
    ])
}

async fn run_tool(name: &str, args: &Value) -> Value {
    match name {
        "load_customer_profile" => json!({
            "userId": args.get("userId").cloned().unwrap_or(Value::Null),
            "tier": "enterprise",
            "activeDeployments": 3,
            "stakeholders": ["ops", "security", "support"],
        }),
        "search_docs" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            json!([
                format!("Runbook note for {}: stage traffic shifts.", q),
                format!("Checklist note for {}: capture operator summary.", q),
                format!("Audit note for {}: persist tool evidence.", q),
            ])
        }
        "slow_policy_scan" => {
            tokio::time::sleep(Duration::from_millis(350)).await;
            json!({
                "topic": args.get("topic").cloned().unwrap_or(Value::Null),
                "requiredChecks": ["security-review", "audit-export", "support-brief"],
            })
        }
        other => json!({ "error": format!("Unknown tool: {}", other) }),
    }
}

#[derive(Deserialize)]
struct ConvoRow {
    id: String,
    #[serde(default)]
    started_at: Option<i64>,
}

async fn resolve_workshop_run_url(workshop_base: &str, started_after_ms: i64) -> Option<String> {
    if workshop_base.is_empty() {
        return None;
    }
    let url = format!("{}/api/convo/{}", workshop_base, CONVO_ID);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    for _ in 0..10 {
        if let Ok(resp) = http.get(&url).send().await {
            if let Ok(rows) = resp.json::<Vec<ConvoRow>>().await {
                if let Some(hit) = rows
                    .iter()
                    .find(|r| r.started_at.unwrap_or(0) >= started_after_ms)
                {
                    let mut run_url = reqwest::Url::parse(workshop_base).ok()?;
                    {
                        let mut path = run_url.path_segments_mut().ok()?;
                        path.push("runs");
                        path.push(&hit.id);
                    }
                    return Some(run_url.to_string());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    None
}


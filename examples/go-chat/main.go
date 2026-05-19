// Package main is the Raindrop go-chat example.
//
// net/http + raindrop-ai (Go) + the OpenAI HTTP API. Mirrors the unified
// chat UX used by the TS examples (pinned-bottom input, multi-turn bubbles,
// Cmd/Ctrl+Enter, knobs, Workshop deep-link footer) and demos
// `Client.Begin → Interaction.Finish` plus `Interaction.TrackTool` so tool
// spans land as TOOL_CALL rows in Workshop's `spans` table.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	raindrop "github.com/raindrop-ai/go"
)

const (
	defaultPort  = "3019"
	convoID      = "go-demo"
	eventName    = "go_chat"
	userID       = "example-user"
	systemPrompt = "You are a deployment-rollout planner for an enterprise SaaS team. " +
		"Use every tool you have access to (each at most once) to gather context, " +
		"then write the final execution plan. Always answer in plain text."
)

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Raindrop Go Chat</title>
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
        <h1>Go SDK Chat</h1>
        <p>net/http + raindrop-ai (Go) with manual <code>interaction.TrackTool</code> spans.</p>

        <details open>
          <summary>System prompt</summary>
          <textarea id="system" rows="5">__SYSTEM_PROMPT__</textarea>
        </details>

        <div class="row">
          <div><label>Model</label><input id="model" placeholder="gpt-4o-mini" /></div>
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
`

type chatMessage struct {
	Role       string            `json:"role"`
	Content    json.RawMessage   `json:"content,omitempty"`
	ToolCalls  []json.RawMessage `json:"tool_calls,omitempty"`
	ToolCallID string            `json:"tool_call_id,omitempty"`
}

type chatRequest struct {
	Messages        []chatMessage `json:"messages"`
	System          string        `json:"system"`
	Model           string        `json:"model"`
	Temperature     *float64      `json:"temperature"`
	TopP            *float64      `json:"topP"`
	MaxOutputTokens *int          `json:"maxOutputTokens"`
	Seed            *int          `json:"seed"`
	MaxSteps        int           `json:"maxSteps"`
	UseTools        bool          `json:"useTools"`
}

type appState struct {
	raindrop     *raindrop.Client
	openaiKey    string
	defaultModel string
	workshopBase string
	openaiClient *http.Client
	workshopHTTP *http.Client
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	workshopURL := raindrop.ResolveLocalWorkshopURL(raindrop.LocalWorkshopConfig{Inherit: true}, true)
	workshopBase := workshopBaseFromEndpoint(workshopURL)

	rdClient, err := raindrop.New(
		raindrop.WithWriteKey(os.Getenv("RAINDROP_WRITE_KEY")),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "raindrop client init failed: %v\n", err)
		os.Exit(1)
	}
	defer rdClient.Close()

	state := &appState{
		raindrop:     rdClient,
		openaiKey:    os.Getenv("OPENAI_API_KEY"),
		defaultModel: envOr("OPENAI_MODEL", "gpt-4o-mini"),
		workshopBase: workshopBase,
		openaiClient: &http.Client{Timeout: 5 * time.Minute},
		workshopHTTP: &http.Client{Timeout: 2 * time.Second},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", state.handleIndex)
	mux.HandleFunc("POST /api/chat", state.handleChat)

	addr := "127.0.0.1:" + port
	srv := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	fmt.Printf("Go SDK chat: http://localhost:%s\n", port)
	if workshopBase != "" {
		fmt.Printf("Workshop base : %s\n", workshopBase)
	}

	// Graceful shutdown on Ctrl+C / SIGTERM so the last in-flight turn's
	// partial events + tool spans get a chance to flush before exit.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "server: %v\n", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func workshopBaseFromEndpoint(endpoint string) string {
	if endpoint == "" {
		return ""
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func (s *appState) handleIndex(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	body := strings.ReplaceAll(html, "__SYSTEM_PROMPT__", systemPrompt)
	io.WriteString(w, body)
}

func (s *appState) handleChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Messages) == 0 {
		http.Error(w, "messages array is required", http.StatusBadRequest)
		return
	}
	if s.openaiKey == "" {
		http.Error(w, "OPENAI_API_KEY is required", http.StatusInternalServerError)
		return
	}
	if req.MaxSteps <= 0 {
		req.MaxSteps = 10
	}
	model := req.Model
	if model == "" {
		model = s.defaultModel
	}
	system := req.System
	if system == "" {
		system = systemPrompt
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	lastUserInput := ""
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			var s string
			if err := json.Unmarshal(req.Messages[i].Content, &s); err == nil {
				lastUserInput = s
			}
			break
		}
	}

	ctx := r.Context()
	startedAt := time.Now().UnixMilli()
	interaction := s.raindrop.Begin(ctx, raindrop.BeginOptions{
		EventID: uuid.NewString(),
		UserID:  userID,
		Event:   eventName,
		Input:   lastUserInput,
		Model:   model,
		ConvoID: convoID,
	})

	finalText, runErr := s.runChatLoop(ctx, w, flusher, &req, model, system, interaction)
	if runErr != nil {
		_ = interaction.Finish(raindrop.FinishOptions{Output: "Error: " + runErr.Error()})
		fmt.Fprintf(w, "\n\n[error] %s\n", runErr.Error())
		if flusher != nil {
			flusher.Flush()
		}
	} else {
		_ = interaction.Finish(raindrop.FinishOptions{Output: finalText})
	}

	// Force buffered partial events + tool spans to flush before we
	// look up the run id in Workshop.
	_ = s.raindrop.Flush(ctx)

	if url := s.resolveWorkshopRunURL(ctx, startedAt); url != "" {
		fmt.Fprintf(w, "\n\n→ Open in Workshop: %s\n", url)
		if flusher != nil {
			flusher.Flush()
		}
	}
}

type streamingToolCall struct {
	id   string
	name string
	args strings.Builder
}

func (s *appState) runChatLoop(
	ctx context.Context,
	w io.Writer,
	flusher http.Flusher,
	req *chatRequest,
	model string,
	system string,
	interaction *raindrop.Interaction,
) (string, error) {
	systemContent, _ := json.Marshal(system)
	messages := []map[string]any{{"role": "system", "content": json.RawMessage(systemContent)}}
	for _, m := range req.Messages {
		raw := map[string]any{"role": m.Role}
		if len(m.Content) > 0 {
			raw["content"] = json.RawMessage(m.Content)
		}
		if len(m.ToolCalls) > 0 {
			raw["tool_calls"] = m.ToolCalls
		}
		if m.ToolCallID != "" {
			raw["tool_call_id"] = m.ToolCallID
		}
		messages = append(messages, raw)
	}

	finalText := ""
	for step := 0; step < req.MaxSteps; step++ {
		body := map[string]any{
			"model":    model,
			"stream":   true,
			"messages": messages,
		}
		if req.Temperature != nil {
			body["temperature"] = *req.Temperature
		}
		if req.TopP != nil {
			body["top_p"] = *req.TopP
		}
		if req.MaxOutputTokens != nil {
			body["max_completion_tokens"] = *req.MaxOutputTokens
		}
		if req.Seed != nil {
			body["seed"] = *req.Seed
		}
		if req.UseTools {
			body["tools"] = toolDefs()
		}

		text, toolCalls, err := s.callOpenAIStream(ctx, body, w, flusher)
		if err != nil {
			return finalText, err
		}

		if len(toolCalls) == 0 {
			finalText = text
			break
		}

		assistantTC := make([]map[string]any, 0, len(toolCalls))
		for _, tc := range toolCalls {
			assistantTC = append(assistantTC, map[string]any{
				"id":   tc.id,
				"type": "function",
				"function": map[string]any{
					"name":      tc.name,
					"arguments": tc.args.String(),
				},
			})
		}
		assistantMsg := map[string]any{
			"role":       "assistant",
			"tool_calls": assistantTC,
		}
		if text != "" {
			assistantMsg["content"] = text
		}
		messages = append(messages, assistantMsg)

		for _, tc := range toolCalls {
			var args map[string]any
			if err := json.Unmarshal([]byte(tc.args.String()), &args); err != nil {
				args = map[string]any{}
			}
			start := time.Now()
			result := runTool(ctx, tc.name, args)
			interaction.TrackTool(raindrop.TrackToolOptions{
				Name:     tc.name,
				Input:    args,
				Output:   result,
				Duration: time.Since(start),
			})
			marshaled, _ := json.Marshal(result)
			messages = append(messages, map[string]any{
				"role":         "tool",
				"tool_call_id": tc.id,
				"content":      string(marshaled),
			})
		}
	}

	return finalText, nil
}

func (s *appState) callOpenAIStream(
	ctx context.Context,
	body map[string]any,
	w io.Writer,
	flusher http.Flusher,
) (string, []*streamingToolCall, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+s.openaiKey)
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := s.openaiClient.Do(httpReq)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		blob, _ := io.ReadAll(resp.Body)
		return "", nil, fmt.Errorf("openai %d: %s", resp.StatusCode, string(blob))
	}

	text := ""
	toolCalls := []*streamingToolCall{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			break
		}
		var evt map[string]any
		if err := json.Unmarshal([]byte(payload), &evt); err != nil {
			continue
		}
		choices, _ := evt["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		delta, _ := choice["delta"].(map[string]any)
		if c, ok := delta["content"].(string); ok && c != "" {
			text += c
			if _, err := io.WriteString(w, c); err != nil {
				return text, toolCalls, fmt.Errorf("client disconnected: %w", err)
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if tcArr, ok := delta["tool_calls"].([]any); ok {
			for _, item := range tcArr {
				tc, _ := item.(map[string]any)
				idxF, _ := tc["index"].(float64)
				idx := int(idxF)
				for len(toolCalls) <= idx {
					toolCalls = append(toolCalls, &streamingToolCall{})
				}
				if id, ok := tc["id"].(string); ok && id != "" {
					toolCalls[idx].id = id
				}
				fn, _ := tc["function"].(map[string]any)
				if name, ok := fn["name"].(string); ok && name != "" {
					toolCalls[idx].name = name
				}
				if args, ok := fn["arguments"].(string); ok && args != "" {
					toolCalls[idx].args.WriteString(args)
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return text, toolCalls, fmt.Errorf("stream read: %w", err)
	}
	return text, toolCalls, nil
}

func toolDefs() []map[string]any {
	return []map[string]any{
		{
			"type": "function",
			"function": map[string]any{
				"name":        "load_customer_profile",
				"description": "Load account metadata for the current customer.",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{"userId": map[string]any{"type": "string"}},
					"required":   []string{"userId"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "search_docs",
				"description": "Search docs for relevant rollout guidance.",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{"query": map[string]any{"type": "string"}},
					"required":   []string{"query"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "slow_policy_scan",
				"description": "Perform a longer compliance scan before rollout.",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{"topic": map[string]any{"type": "string"}},
					"required":   []string{"topic"},
				},
			},
		},
	}
}

func runTool(ctx context.Context, name string, args map[string]any) any {
	switch name {
	case "load_customer_profile":
		return map[string]any{
			"userId":            args["userId"],
			"tier":              "enterprise",
			"activeDeployments": 3,
			"stakeholders":      []string{"ops", "security", "support"},
		}
	case "search_docs":
		q, _ := args["query"].(string)
		return []string{
			fmt.Sprintf("Runbook note for %s: stage traffic shifts.", q),
			fmt.Sprintf("Checklist note for %s: capture operator summary.", q),
			fmt.Sprintf("Audit note for %s: persist tool evidence.", q),
		}
	case "slow_policy_scan":
		select {
		case <-time.After(350 * time.Millisecond):
		case <-ctx.Done():
		}
		return map[string]any{
			"topic":          args["topic"],
			"requiredChecks": []string{"security-review", "audit-export", "support-brief"},
		}
	default:
		return map[string]any{"error": fmt.Sprintf("Unknown tool: %s", name)}
	}
}

func (s *appState) resolveWorkshopRunURL(ctx context.Context, startedAfterMs int64) string {
	if s.workshopBase == "" {
		return ""
	}
	endpoint := s.workshopBase + "/api/convo/" + convoID
	for i := 0; i < 10; i++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err == nil {
			resp, err := s.workshopHTTP.Do(req)
			if err == nil {
				var rows []struct {
					ID        string `json:"id"`
					StartedAt int64  `json:"started_at"`
				}
				_ = json.NewDecoder(resp.Body).Decode(&rows)
				resp.Body.Close()
				for _, row := range rows {
					if row.StartedAt >= startedAfterMs {
						return s.workshopBase + "/runs/" + url.PathEscape(row.ID)
					}
				}
			}
		}
		select {
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			return ""
		}
	}
	return ""
}

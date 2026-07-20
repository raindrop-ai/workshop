# pi-agent-chat

End-to-end demo of [`@raindrop-ai/pi-agent`](https://www.npmjs.com/package/@raindrop-ai/pi-agent) instrumenting [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono) running prompts via [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai). Each turn opens a Raindrop event and one LLM span; tool calls (when the model invokes them) become tool spans, all mirrored to the local Workshop daemon when one is running.

## Setup

```bash
cd examples/pi-agent-chat
bun install
```

Provider creds: pi-ai reads from the same env vars OpenAI/Anthropic SDKs use (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc).

## Run

```bash
bun run dev
# or via the workshop dev-all aggregator (pinned to port 3020):
bun run dev:examples
```

Open `http://localhost:3020`. Each chat turn calls `Agent.prompt()`, raindrop-pi-agent ships traces to the local Workshop daemon (auto-detected on `localhost:5899`), and the response bubble links to the resulting run.

## Workshop wiring

`createRaindropPiAgent` resolves the Workshop URL via the canonical contract from `@raindrop-ai/core`:

1. Explicit `localWorkshopUrl` ctor option (string forces, `null` opts out)
2. `RAINDROP_LOCAL_DEBUGGER` env var
3. `RAINDROP_WORKSHOP` env (URL or boolean)
4. Auto-detect: `NODE_ENV=development` or localhost-ish hostname

`writeKey` is optional — without one, the SDK runs in local-only mode and ships only to the resolved Workshop URL.

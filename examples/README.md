# Examples

End-to-end demo apps for Raindrop SDKs and framework integrations. Each
example is a single-file chat server that mirrors traces to Workshop and
renders a tiny HTML chat UI on a pinned port.

Pick one, send a turn, and the resulting run is visible at
[http://localhost:5899](http://localhost:5899).

## Prerequisites

- A running Workshop daemon. Either install the CLI
  (`curl -fsSL https://raw.githubusercontent.com/raindrop-ai/workshop/main/install.sh | bash`)
  and run `raindrop workshop`, or run from source: `bun run dev` from the repo root.
- A provider API key for whichever example you pick: `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, etc.

No env vars are required to connect to Workshop — the SDKs auto-detect
`localhost:5899` in development.

## Boot Everything

```bash
bun run dev:examples
```

Spawns the Workshop daemon on `:5899` plus each example on its pinned port,
with `RAINDROP_LOCAL_DEBUGGER` pre-wired. Examples whose toolchain
isn't on `$PATH` (no `cargo`, no `go`, no `opencode` CLI) are skipped with a
one-line install hint. Ctrl-C stops everything cleanly.

## Run One

```bash
cd examples/openai-chat && bun install && bun run dev
```

Then open the example's port (see the table below) and send a turn. The reply
ends with an `Open in Workshop` deep link to the run.

## All Examples

| Example | What it demonstrates | Runtime | Port |
| --- | --- | --- | --- |
| [`openai-chat`](./openai-chat) | Official OpenAI SDK + manual `withTool` / `withSpan` / `emitLiveEvent` | bun | 3012 |
| [`ai-sdk-chat`](./ai-sdk-chat) | Vercel AI SDK + `@raindrop-ai/ai-sdk` auto-instrumentation | bun | 3011 |
| [`anthropic-chat`](./anthropic-chat) | Official Anthropic SDK + manual instrumentation, native thinking deltas | bun | 3013 |
| [`ai-sdk-otelv2`](./ai-sdk-otelv2) | Vercel AI SDK via the OTel v2 telemetry path (`raindrop-ai@0.1.1-otelv2`) | bun | 3014 |
| [`claude-agent-sdk`](./claude-agent-sdk) | `@anthropic-ai/claude-agent-sdk` wrapped by `@raindrop-ai/claude-agent-sdk` | bun | 3015 |
| [`browser-chat`](./browser-chat) | `@raindrop-ai/browser-sdk` `trackAiPartial` from the browser | bun | 3016 |
| [`python-chat`](./python-chat) | `aiohttp` + OpenAI Python SDK + `raindrop-ai` (Python) | python | 3017 |
| [`rust-chat`](./rust-chat) | `axum` + `reqwest` + `raindrop-ai` (Rust crate) | rust | 3018 |
| [`go-chat`](./go-chat) | `net/http` + `raindrop-ai/go` | go | 3019 |
| [`pi-agent-chat`](./pi-agent-chat) | `@raindrop-ai/pi-agent` instrumenting `@mariozechner/pi-agent-core` | bun | 3020 |
| [`opencode-plugin-chat`](./opencode-plugin-chat) | The real OpenCode CLI loading `@raindrop-ai/opencode-plugin` | bun | 3021 |
| [`opencode-observer-agent`](./opencode-observer-agent) | A second OpenCode process acting as an LLM-as-judge observer that reads Workshop SQLite traces and posts steering nudges | bun | 3031 |

Each row links to a per-example README with provider keys, what the demo
exercises, and what to look for in the Workshop UI.

## Conventions

- **Ports are pinned per example.** URLs stay stable for screenshots, docs,
  and Playwright tests. Defined in [`scripts/dev-all.ts`](../scripts/dev-all.ts).
- **Workshop URL resolution** follows the canonical contract from
  `@raindrop-ai/core`: explicit `localWorkshopUrl` → `RAINDROP_LOCAL_DEBUGGER` →
  `RAINDROP_WORKSHOP` → auto-detect when `NODE_ENV=development` or the
  hostname is localhost-ish. Example servers set `NODE_ENV=development` so
  rule 4 kicks in out-of-the-box.
- **`writeKey` is optional.** Without one, the SDK runs in local-only mode and
  mirrors to Workshop. Set `RAINDROP_WRITE_KEY` to also ship to cloud.

## Adding a New Example

1. Create `examples/<your-name>/` with a `server.ts` (or `server.py` /
   `main.go` / `src/main.rs`) that self-hosts on a `PORT` env var, with a
   default port not already used in [`scripts/dev-all.ts`](../scripts/dev-all.ts).
2. Set `process.env.NODE_ENV ??= "development"` so the local Workshop mirror
   auto-resolves.
3. Add the entry to `EXAMPLE_APPS` in
   [`scripts/dev-all.ts`](../scripts/dev-all.ts).
4. Add a row to the table above and a per-example README matching the shape
   of the existing ones.

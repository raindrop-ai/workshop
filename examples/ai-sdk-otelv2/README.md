# AI SDK (OTel v2)

Vercel AI SDK + `raindrop-ai`'s OTel v2 telemetry path
(`experimental_telemetry.metadata = interaction.vercelAiSdkMetadata()`).

This example pins `raindrop-ai@0.4.0-otelv2`, a pre-release that wires
AI SDK v6 telemetry through OpenTelemetry into the Raindrop trace store.
The "regular" `ai-sdk-chat` example uses `@raindrop-ai/ai-sdk`'s
auto-wrap; use this one when you need the OTel-native path
(e.g. cross-tracing with another OTel pipeline).

## Requires

- `OPENAI_API_KEY`

## Run

```bash
cd examples/ai-sdk-otelv2
bun install
bun run dev
```

Open <http://localhost:3014>. Each turn produces one Workshop run with
the `ai.streamText` span (via OTel) + tool spans; the "Open in Workshop"
link in the reply jumps you straight to it.

Workshop auto-detected on `localhost:5899`. Override with
`RAINDROP_LOCAL_DEBUGGER=http://host:port/v1/`.

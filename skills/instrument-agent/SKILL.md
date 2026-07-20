---
name: instrument-agent
description: >
  Set up Raindrop AI traces for an agent and verify they flow into Workshop. Use when the user
  says "set up traces", "add tracing", "instrument my agent", "wire Raindrop", "Workshop is empty",
  or "make traces show up in Workshop." Guides unknown repos by discovering runtime and telemetry
  setup, using current Raindrop docs/package types, making the smallest safe change, and proving
  one useful Workshop run. Not for repos that already have working Raindrop instrumentation —
  use for initial setup or when Workshop shows no data.
---

You are helping instrument an AI agent so its next meaningful run appears in Raindrop Workshop. Workshop is the local viewer; it does not run the agent. The user's agent app runs the workflow, the Raindrop SDK captures model/tool boundaries and context, and Workshop renders that telemetry as a debuggable run.

Use supported Raindrop SDK/integration paths. Do not hand-wire Workshop ingestion endpoints or invent SDK APIs. If the repo's telemetry setup is too custom to instrument safely, stop with a clear handoff to the Raindrop docs or team.

## Use Docs First

Raindrop SDK and integration APIs move quickly. Before writing code, fetch docs in parallel: the docs index, the likely stack-specific page, and installed package README/types when available.

- Docs index: `https://raindrop.ai/docs/llms.txt`
- Introduction: `https://raindrop.ai/docs/introduction`
- Integration overview: `https://raindrop.ai/docs/integrations/overview`
- Core SDKs: `https://raindrop.ai/docs/sdk/typescript`, `/sdk/python`, `/sdk/rust`, `/sdk/go`, `/sdk/http-api`, `/sdk/browser`
- Framework integrations: `https://raindrop.ai/docs/integrations/<name>` such as `vercel-ai-sdk`, `claude-agent-sdk`, `langchain`, `openai-agents`, `pydantic-ai`, `google-adk`, `bedrock`, `azure-openai`, `vertex-ai`

Use this skill for the workflow and Workshop-specific judgment. Use the docs and installed package README/types for exact install commands, imports, options, and signatures.

## Core Rules

- Give visible progress. Say what phase you are in, what you learned, and what you are about to edit. Do not silently research for minutes.
- Report often but briefly: one or two sentences per update, focused on current phase, finding, and next step. Avoid long dumps unless you are blocked and need a decision.
- Before editing any file, tell the user about the intended change, and give them an honest assessment for how risky it might be.
- Instrument one real agent entry point first. If several are plausible, ask which one should appear in Workshop.
- First get a minimal useful run into Workshop, then enrich it. Do not trace every helper/tool/sub-agent before Phase 1 works.
- Respect existing telemetry ownership. If the repo already initializes OpenTelemetry, Sentry, Datadog, Honeycomb, Traceloop, LangSmith, or another provider, do not create a competing provider.
- Updating the matching Raindrop SDK/integration to the latest available version is mandatory before instrumentation edits. Do not proceed on an older installed SDK just because it is already present.
- Prefer installed package docs/types over memory. If an API is not present in the installed package, do not use it.
- Verification is required. Success means Workshop shows a useful run, not just that dependencies installed.

## Mental Model

One useful Workshop run should show:

- the user/job input that triggered the agent,
- the final output or error,
- the main LLM call,
- real tool executions and their results,
- enough properties to recognize the customer/session/job being debugged.

Most integrations use one of three shapes:

- **Interaction boundary:** `begin` when one invocation starts, run the model/tool loop, then `finish` with output or error. Use this for Python, Rust, TypeScript core SDK, and custom loops.
- **SDK wrapper:** wrap the agent/model SDK once and pass per-call metadata. Use this for Vercel AI SDK, Claude Agent SDK, and similar integrations.
- **Existing OpenTelemetry owner:** attach Raindrop through the existing telemetry setup if supported. Do not create a second global tracer/provider.

## Phase 0: Orient

Do a quick read-only pass:

- Find the target agent entry point: route, worker, CLI, queue job, MCP server, or agent class.
- Identify language/runtime and model/agent SDK: Python, Rust, TypeScript, Vercel AI SDK, Claude Agent SDK, OpenAI/Anthropic direct SDK, LangChain, etc.
- For Python, record `python --version`, package version, and the actual `raindrop.analytics` surface before assuming current docs apply.
- Identify where tools actually execute.
- Identify package manager and env file convention.
- Search for existing telemetry: `opentelemetry`, `NodeSDK`, `TracerProvider`, `Sentry.init`, Datadog, Honeycomb, Traceloop, LangSmith, `RAINDROP_*`.
- Check whether Workshop is running: `curl -fsS http://localhost:5899/health`.

Timebox this phase. If discovery is not converging quickly, report what you know and ask the smallest concrete question.

Ask only when the next edit would otherwise be a guess. Keep it concrete:

- "I found `apps/api/src/chat.ts` and `workers/agent.ts`. Which should appear in Workshop first?"
- "I found `src/sentry.ts` and `src/otel.ts`. Which telemetry initializer runs in this agent process?"
- "What command runs one representative agent invocation locally?"

## Phase 1: Basic Run Visibility

Goal: prove the local trace path works with the smallest top-level instrumentation. A successful Phase 1 may show only a basic interaction summary in Workshop; it does not need complete LLM/tool span coverage.

Make the smallest change:

- Install or update the matching Raindrop SDK/integration to the latest available version using the repo's package manager, then inspect the installed README/types before coding.
- Point the app at local Workshop, usually with `RAINDROP_LOCAL_DEBUGGER=http://localhost:5899/v1/`.
- Add minimal instrumentation to one real entry point: wrapper call metadata, or `begin` before the invocation and `finish` after final output/error.
- Run one representative invocation.
- Verify a run appears in Workshop with enough input/output to prove the right code path is connected.

Phase 1 troubleshooting:

- If Workshop is empty, confirm the command exercised the instrumented entry point.
- If the app ran but no run appears, confirm the app process received the local Workshop env/config.
- If using a wrapper SDK, confirm the invoked code calls the wrapped client, not the original import.
- If using `begin`/`finish`, confirm both run in the invoked path and flush/close happens before short-lived processes exit.
- If existing telemetry is present, confirm you did not create a second competing provider.
- If Workshop is not reachable, stop and say Workshop is down. Do not say "wired" or point the user at the Workshop URL as if verification succeeded.
- If these checks do not reveal the problem, stop and report the exact evidence instead of adding more instrumentation.

## Phase 2: Enrichment

Goal: turn the Phase 1 run into a useful debugging trace.

After Phase 1 works:

- Add useful `properties`: tenant/org/workspace, request/job/session/conversation IDs, route/source/surface. Do not invent placeholders.
- Ensure the LLM call is visible as an LLM span or obvious interaction summary.
- Ensure real tool executions are visible as tool spans/events.
- Preserve existing telemetry setup.
- Add streaming/live events only when the SDK supports them and they help debugging.

Phase 2 troubleshooting:

- Thin Overview: fix interaction input/output and useful properties.
- Missing LLM call: confirm the model call uses the wrapper or a supported span helper.
- Missing tools: wrap the real tool body, not the model's tool-call decision.
- Duplicate tools: check for both framework auto-instrumentation and manual wrapping on the same operation.

## Choosing The Path

Always consult docs first, then use the notes below to decide.

### TypeScript Core SDK

Docs: `https://raindrop.ai/docs/sdk/typescript`

Hard version gate: require the latest available `raindrop-ai` package for TypeScript/JavaScript core SDK instrumentation, and never lower than `0.0.90`. If the repo has an older installed package, update first or stop and report the version mismatch.

Use for custom TypeScript/Node agents and direct provider SDK calls. The core shape is:

```ts
const raindrop = new Raindrop({
  writeKey: process.env.RAINDROP_WRITE_KEY,
  endpoint: process.env.RAINDROP_ENDPOINT ?? process.env.RAINDROP_LOCAL_DEBUGGER,
});

const interaction = raindrop.begin({
  eventId,
  event: "agent_name",
  userId,
  input,
  convoId,
  properties,
});

try {
  const output = await runAgentLoop();
  interaction.finish({ output, model });
} catch (err) {
  interaction.finish({ output: `Error: ${err instanceof Error ? err.message : String(err)}` });
  throw err;
} finally {
  await raindrop.flush();
}
```

In Phase 2, use the current docs/package types for manual span/tool helpers and only wrap real execution boundaries.

### Vercel AI SDK

Docs: `https://raindrop.ai/docs/integrations/vercel-ai-sdk`

Use `@raindrop-ai/ai-sdk`. This integration is designed to avoid manual OpenTelemetry setup. The docs cover:

- `raindrop.wrap(ai, ...)`,
- `eventMetadata(...)`,
- AI SDK version differences,
- native telemetry for AI SDK v7+,
- tool call tracing,
- flush/shutdown and debugging.

Gotchas to keep inline:

- `eventMetadata(...)` is call metadata, not a side effect.
- Verify the invoked code calls the wrapped functions/client.
- Do not choose native telemetry unless installed docs/types and AI SDK version support it.

### Claude Agent SDK

Docs: `https://raindrop.ai/docs/integrations/claude-agent-sdk`

Use `@raindrop-ai/claude-agent-sdk`. The docs cover wrapping the Claude Agent SDK, passing `eventMetadata()` to tracked `query()` calls, auto tool tracing, subagent hierarchy, flush/shutdown, and debugging.

Gotcha: calls without `eventMetadata()` may run normally but not be tracked by Raindrop, depending on the installed package behavior.

### Python

Docs: `https://raindrop.ai/docs/sdk/python`

Use `raindrop-ai`. For Phase 1, prefer `raindrop.begin(...)` before the custom loop and `interaction.finish(...)` after final output/error. This proves Workshop connectivity without needing perfect tool spans.

For Python custom loops:

- Check Python and `raindrop-ai` versions first, then update `raindrop-ai` to the latest available version before editing instrumentation.
- Do not use `track_ai` as a Workshop Phase 1 path. If the installed package only exposes `track_ai`, stop and report that this package version cannot produce a visible Workshop run with the current local ingestion behavior.
- Phase 1: wrap the whole model/tool loop with `begin`/`finish`.
- Phase 2: preserve loop behavior and add instrumentation at real boundaries: provider call and tool function execution.
- Python tool/span helpers, decorators, manual spans, and auto-instrumentation may require tracing to remain enabled. Verify useful Workshop spans before promising tool-level coverage.
- If the Python app already has a complex OTEL/Sentry setup, do not modify it unless you can follow a supported Raindrop SDK path.

### Rust

Docs: `https://raindrop.ai/docs/sdk/rust`

Use the Rust `raindrop-ai` crate and the installed crate docs/API. The docs describe `Client::begin`, `Interaction::finish`, `Client::flush`/`close`, `track_ai`, manual spans, and tool spans.

Keep guidance short:

- Phase 1: wrap the whole async agent loop with `begin`/`finish`, then `flush` or `close`.
- Phase 2: use documented Rust span/tool helpers only after the top-level run lands.
- The Rust SDK is beta. Pin the crate/tag as the docs recommend and trust installed crate APIs.

### Other Framework Integrations

Docs index: `https://raindrop.ai/docs/llms.txt`

For LangChain, OpenAI Agents SDK, Pydantic AI, Google ADK, Bedrock, Azure OpenAI, Vertex AI, CrewAI, Strands, and similar frameworks, prefer the matching integration docs over inventing generic wrappers.

If no supported integration fits, stop gracefully:

> I could not find a safe Raindrop SDK/integration path for this setup. Please consult the Raindrop docs or reach out to the Raindrop team with the agent entry point and telemetry setup files.

## Existing OpenTelemetry / Sentry / Datadog

This is the main case where the skill should add value beyond docs.

If the app already owns telemetry:

- Find the initializer that actually runs in the agent process.
- Do not create a second `NodeSDK`, tracer provider, or equivalent global provider.
- Look for a Raindrop-supported "external OpenTelemetry" shape in the installed package docs/types.
- Some setups need only a Raindrop span processor. Others also need Raindrop instrumentations. Do not invent `instrumentModules`; use only what installed docs/types require.
- After the smallest integration, run the agent once and verify Workshop before tuning modules/instrumentations.

If you cannot identify the telemetry owner, ask for that file or stop with a handoff to docs/team.

## Verification

Use the strongest available check:

- Raindrop MCP when available: inspect the current/latest run, outline, or trace query results.
- HTTP/local API only if supported by the current Workshop docs or installed tooling.
- UI: a visible run in Workshop.

Confirm the run is useful:

- Phase 1 success: one real invocation appears with input/output or a clear interaction summary.
- Phase 2 success: expected LLM/tool activity is visible in Overview or span tree.

If a run exists but content is not useful, verification failed. Keep diagnosing or stop with exact evidence.

## Handoff

Verified:

> Wired. I ran the agent once and confirmed a useful Workshop run at http://localhost:5899.

Needs user run:

> Wired. Workshop is running at http://localhost:5899. Run `<command>` now; the next run should appear in Workshop. If it stays empty, we can debug further!

Blocked:

> I stopped before guessing. `<specific ambiguity/failure>`. The next step is `<specific user choice or docs/team handoff if nothing truly works (try your hardest before doing this. For Team handoff, report diagnostics, code skeleton without revealing too much about user's proprietary code)>`.

import { expect, test } from "./fixtures";
import {
  assertLlmSpanShape,
  pickPort,
  pollOutline,
  outlineMatches,
  readWorkshopSpans,
  requireEnvOrThrow,
  runStandardChatTurn,
  spawnTsExample,
  TEST_PROMPT_RX,
  verifyRunDetailUi,
} from "./helpers";

// 120s send budget + DB poll + the rich UI/DB assertions this canonical
// spec carries can exceed the 90s file default. `test.setTimeout` sets the
// per-test budget; the hook keeps the config-default 90s, which is ample
// for the env check here.
test.setTimeout(180_000);

test.beforeAll(() => requireEnvOrThrow("OPENAI_API_KEY"));

// ai-sdk-chat is the canonical real-LLM spec — it carries the richer
// UI + raw-DB assertions on behalf of the whole matrix. Adding the same
// assertions to every example would amplify flake without adding signal.
// Other example specs assert only what's example-specific (SDK ingest
// path) and rely on this one to guard the workshop UI/DB contract.
test("ai-sdk-chat: SDK ships → workshop UI renders + DB matches", async ({ page, workshop }, testInfo) => {
  const example = await spawnTsExample({
    name: "ai-sdk-chat",
    port: pickPort(testInfo.workerIndex, 0),
    workshopUrl: workshop.url,
    extraEnv: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
  });
  try {
    // gpt-5.4-mini is a reasoning model and this example's system prompt
    // forces a tool fan-out (delegate_research_agent, slow_policy_scan),
    // which intermittently pushes a single turn past the default 75s and
    // flakes CI. Disable tools + widen the budget (matching go-chat /
    // rust-chat, also gpt-5.4-mini). The streaming text path still drives
    // the full SDK→ingest→DB→UI chain this canonical spec asserts on.
    const { workshopUrl, runId } = await runStandardChatTurn(page, example.url, {
      sendTimeoutMs: 120_000,
      disableTools: true,
    });

    // 1. Public API: outline endpoint sees a run with the prompt in a
    //    payload location (catches API-shape regressions).
    const outline = await pollOutline(workshop.url, runId, outlineMatches("ai_sdk_chat", TEST_PROMPT_RX));
    expect(outline.spans.length).toBeGreaterThan(0);

    // 2. Spans endpoint: per-span shape + payload preview. The /spans
    //    `input_preview` field is `SUBSTR(input_payload, 1, payload_preview_chars)`
    //    so it shares fate with the raw column — a regression that
    //    truncated the column would be visible here. Cheaper than
    //    opening sqlite directly (which we tried; bun:sqlite on macOS
    //    can't see WAL pages written by a sibling process pre-checkpoint).
    const spans = await readWorkshopSpans(workshop.url, runId);
    expect(spans.length).toBe(outline.spans.length);
    const llmSpans = spans.filter((s) => s.span_type === "LLM_GENERATION");
    expect(llmSpans.length, "expected at least one LLM_GENERATION span").toBeGreaterThan(0);
    const promptInRawPayload = spans.some(
      (s) =>
        (s.input_payload && TEST_PROMPT_RX.test(s.input_payload)) ||
        (s.output_payload && TEST_PROMPT_RX.test(s.output_payload)),
    );
    expect(promptInRawPayload, "prompt sentinel missing from raw input/output_payload column").toBe(true);

    // 2b. SDK propagated the openai default model into the LLM span. The
    //     ai-sdk wrapper emits both an outer `ai.streamText` LLM_GENERATION
    //     (model=gpt-5.4-mini) and an inner `LLM` span (model snapshot id
    //     gpt-5.4-mini-2026-03-17). Either matches the openai prefix.
    await assertLlmSpanShape(workshop.url, runId, { modelRegex: /^gpt/i });

    // 3. UI: Overview tab renders the prompt, Span Tree renders the
    //    span rows, side panel opens on row click.
    await verifyRunDetailUi(page, workshopUrl, {
      textRegex: TEST_PROMPT_RX,
      minSpanCount: outline.spans.length,
    });
  } finally {
    await example.stop();
  }
});

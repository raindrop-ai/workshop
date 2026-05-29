import { describe, expect, test } from "bun:test";
import { parseOtlpRequest } from "../src/parse";

function attr(key: string, value: string | number | boolean) {
  if (typeof value === "number") return { key, value: { intValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

function otlpRequest(attributes: ReturnType<typeof attr>[]) {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
                name: "cohere.rerank",
                startTimeUnixNano: "0",
                endTimeUnixNano: "1000000",
                attributes,
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("parseOtlpRequest", () => {
  test("reads top-level replayRunId metadata", () => {
    const spans = parseOtlpRequest(otlpRequest([
      attr("raindrop.replayRunId", "replay_123"),
    ]));

    expect(spans).toHaveLength(1);
    expect(spans[0].replayRunId).toBe("replay_123");
  });

  test("normalizes legacy Cohere gen_ai.prompt user attributes", () => {
    const spans = parseOtlpRequest(otlpRequest([
      attr("llm.request.type", "rerank"),
      attr("gen_ai.prompt.0.role", "user"),
      attr("gen_ai.prompt.0.user", "Which result is best?"),
      attr("gen_ai.completion.0.content", "Document 2"),
    ]));

    expect(spans).toHaveLength(1);
    expect(spans[0].inputPayload).toContain("Which result is best?");
    expect(spans[0].normalized.kind).toBe("llm");
    if (spans[0].normalized.kind === "llm") {
      expect(spans[0].normalized.messages[0]?.content).toBe("Which result is best?");
    }
  });

  test("reads total-only token usage without split input or output tokens", () => {
    const spans = parseOtlpRequest(otlpRequest([
      attr("llm.request.type", "rerank"),
      attr("llm.usage.total_tokens", 7),
    ]));

    expect(spans).toHaveLength(1);
    expect(spans[0].inputTokens).toBeUndefined();
    expect(spans[0].outputTokens).toBeUndefined();
    expect(spans[0].totalTokens).toBe(7);
  });
});

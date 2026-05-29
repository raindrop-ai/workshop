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
                name: "openai.chat",
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
  test("reads legacy OpenLLMetry gen_ai token usage attributes", () => {
    const spans = parseOtlpRequest(otlpRequest([
      attr("gen_ai.usage.prompt_tokens", 1357),
      attr("gen_ai.usage.completion_tokens", 82),
    ]));

    expect(spans).toHaveLength(1);
    expect(spans[0].inputTokens).toBe(1357);
    expect(spans[0].outputTokens).toBe(82);
  });
});

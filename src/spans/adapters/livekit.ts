import type { SpanAdapter, AdapterMatch } from "./types";
import type { NormalizedMessage } from "../normalized";
import { extractContent, lastUserText, parseJsonOrRaw, roleOrUnknown } from "./helpers";

// Adapters for livekit-agents Python SDK spans (lk.* namespace).
export const livekitLlmAdapter: SpanAdapter = {
  name: "livekit-llm",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "LLM_GENERATION") return null;
    const chatCtxRaw = input.attrs["lk.chat_ctx"] as string | undefined;
    if (typeof chatCtxRaw !== "string" || !chatCtxRaw) return null;

    let parsed: unknown;
    try { parsed = JSON.parse(chatCtxRaw); } catch { return null; }

    const items = extractItems(parsed);
    if (items.length === 0) return null;

    const messages: NormalizedMessage[] = [];
    const systemBuf: string[] = [];

    for (const item of items) {
      const type = typeof item.type === "string" ? item.type : "message";
      if (type === "message") {
        const role = typeof item.role === "string" ? item.role : "user";
        const text = flattenContent(item.content);
        if (role === "system" || role === "developer") {
          if (text) systemBuf.push(text);
        } else if (text) {
          messages.push({ role: roleOrUnknown(role), content: text, raw: item });
        }
      } else if (type === "function_call") {
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? "");
        const callId = typeof item.call_id === "string" ? item.call_id : undefined;
        messages.push({
          role: "assistant",
          content: JSON.stringify({ id: callId, name, arguments: args }),
          raw: item,
        });
      } else if (type === "function_call_output") {
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        const callId = typeof item.call_id === "string" ? item.call_id : undefined;
        messages.push({ role: "tool", content: output, toolCallId: callId, raw: item });
      }
    }

    const responseText = input.attrs["lk.response.text"] as string | undefined;
    const responseFnCallsRaw = input.attrs["lk.response.function_calls"] as string | undefined;
    const outputParts: string[] = [];
    if (responseText) outputParts.push(responseText);
    if (responseFnCallsRaw) outputParts.push(responseFnCallsRaw);
    const outputPayload = outputParts.length ? outputParts.join("\n\n") : undefined;

    const model = (input.attrs["gen_ai.request.model"] as string | undefined)
      ?? (input.attrs["gen_ai.response.model"] as string | undefined);

    return {
      inputPayload: chatCtxRaw,
      outputPayload,
      normalized: {
        kind: "llm",
        messages,
        userMessage: lastUserText(messages),
        systemPrompt: systemBuf.join("\n\n"),
        model,
      },
    };
  },
};

export const livekitToolAdapter: SpanAdapter = {
  name: "livekit-tool",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "TOOL_CALL") return null;
    const name = input.attrs["lk.function_tool.name"] as string | undefined;
    if (typeof name !== "string" || !name) return null;

    const argsRaw = input.attrs["lk.function_tool.arguments"] as string | undefined;
    const outputRaw = input.attrs["lk.function_tool.output"] as string | undefined;
    const isErrorAttr = input.attrs["lk.function_tool.is_error"];
    const errorMessage = input.attrs["otel.status.message"] as string | undefined;

    const resultIsError =
      isErrorAttr === "true" || isErrorAttr === 1 || !!errorMessage;
    const resultRaw = outputRaw ?? errorMessage;

    return {
      inputPayload: argsRaw,
      outputPayload: resultRaw,
      normalized: {
        kind: "tool",
        name,
        args: parseJsonOrRaw(argsRaw),
        result: parseJsonOrRaw(resultRaw),
        resultIsError,
      },
    };
  },
};

function extractItems(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === "object") {
    const items = (parsed as { items?: unknown }).items;
    if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  }
  return [];
}

function flattenContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : extractContent(part)))
      .filter(Boolean)
      .join("\n");
  }
  return extractContent(content);
}

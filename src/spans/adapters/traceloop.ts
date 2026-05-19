import type { SpanAdapter, AdapterMatch } from "./types";
import type { NormalizedMessage } from "../normalized";
import { extractContent, lastUserText, parseJsonOrRaw, roleOrUnknown } from "./helpers";

/**
 * Traceloop-instrumented LLM spans.
 *
 * Traceloop's OpenLLMetry instrumentation emits prompt / response under
 * `traceloop.entity.input` / `traceloop.entity.output` (each a JSON-encoded
 * string), with `traceloop.span.kind === "llm"` as the discriminator.
 *
 * Schema we've seen in the wild:
 *   - `traceloop.entity.input` parses to `[{ role, content }, ...]`
 *   - or to `{ messages: [...], system: "...", model: "..." }`
 *   - non-text content blocks are rare but handled by `extractContent`
 */
export const traceloopLlmAdapter: SpanAdapter = {
  name: "traceloop-llm",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "LLM_GENERATION") return null;
    if (
      input.traceloopKind !== "llm" &&
      !isCurrentGenAiSpan(input.attrs) &&
      !isLegacyGenAiSpan(input.attrs)
    ) return null;

    const genAi = normalizeGenAiMessages(input.attrs);
    if (genAi) {
      const model = (input.attrs["gen_ai.response.model"] as string | undefined)
        ?? (input.attrs["gen_ai.request.model"] as string | undefined)
        ?? (input.attrs["llm.request.model"] as string | undefined);

      return {
        inputPayload: genAi.inputPayload,
        outputPayload: genAi.outputPayload,
        normalized: {
          kind: "llm",
          messages: genAi.messages,
          userMessage: lastUserText(genAi.messages),
          systemPrompt: genAi.systemPrompt,
          model,
        },
      };
    }

    const raw = input.attrs["traceloop.entity.input"] as string | undefined;
    if (typeof raw !== "string" || !raw) return null;

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }

    const messages: NormalizedMessage[] = [];
    let systemPrompt = "";

    const list: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? parsed as Array<Record<string, unknown>>
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as any).messages))
        ? ((parsed as any).messages as Array<Record<string, unknown>>)
        : [];

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sys = (parsed as Record<string, unknown>).system;
      if (typeof sys === "string") systemPrompt = sys;
      else if (Array.isArray(sys)) {
        systemPrompt = sys.map(s => typeof s === "string" ? s : extractContent(s)).filter(Boolean).join("\n\n");
      }
    }

    const sys: string[] = [];
    for (const m of list) {
      const role = (m.role as string | undefined) ?? "unknown";
      const content = extractContent(m.content);
      if (role === "system") {
        if (content) sys.push(content);
      } else if (content || role === "tool") {
        messages.push({ role: roleOrUnknown(role), content, raw: m });
      }
    }
    if (sys.length) systemPrompt = systemPrompt ? [systemPrompt, ...sys].join("\n\n") : sys.join("\n\n");

    if (messages.length === 0 && !systemPrompt) return null;

    const outputPayload = input.attrs["traceloop.entity.output"] as string | undefined;
    const model = (input.attrs["gen_ai.request.model"] as string | undefined)
      ?? (input.attrs["llm.request.model"] as string | undefined);

    return {
      inputPayload: raw,
      outputPayload,
      normalized: {
        kind: "llm",
        messages,
        userMessage: lastUserText(messages),
        systemPrompt,
        model,
      },
    };
  },
};

function isCurrentGenAiSpan(attrs: Record<string, string | number | boolean>): boolean {
  const operationName = attrs["gen_ai.operation.name"];
  return operationName === "chat" ||
    operationName === "text_completion" ||
    operationName === "generate_content" ||
    typeof attrs["gen_ai.input.messages"] === "string" ||
    typeof attrs["gen_ai.output.messages"] === "string";
}

function isLegacyGenAiSpan(attrs: Record<string, string | number | boolean>): boolean {
  return attrs["llm.request.type"] === "chat" ||
    attrs["llm.request.type"] === "completion" ||
    hasIndexedAttr(attrs, "gen_ai.prompt.") ||
    hasIndexedAttr(attrs, "gen_ai.completion.");
}

function hasIndexedAttr(attrs: Record<string, string | number | boolean>, prefix: string): boolean {
  return Object.keys(attrs).some((key) => key.startsWith(prefix));
}

function normalizeGenAiMessages(attrs: Record<string, string | number | boolean>): {
  messages: NormalizedMessage[];
  systemPrompt: string;
  inputPayload?: string;
  outputPayload?: string;
} | null {
  const current = normalizeCurrentGenAiMessages(attrs);
  if (current) return current;
  return normalizeLegacyIndexedGenAiMessages(attrs);
}

function normalizeCurrentGenAiMessages(attrs: Record<string, string | number | boolean>) {
  const inputRaw = attrs["gen_ai.input.messages"] as string | undefined;
  const outputRaw = attrs["gen_ai.output.messages"] as string | undefined;
  const systemRaw = attrs["gen_ai.system_instructions"] as string | undefined;
  if (!inputRaw && !outputRaw && !systemRaw) return null;

  const input = parseJsonOrRaw(inputRaw);
  const output = parseJsonOrRaw(outputRaw);
  const system = parseJsonOrRaw(systemRaw);

  const messages = Array.isArray(input)
    ? input.map(messageFromGenAiObject).filter((m): m is NormalizedMessage => !!m)
    : [];
  const outputText = Array.isArray(output)
    ? output.map(genAiTextContent).filter(Boolean).join("\n\n")
    : typeof output === "string" ? output : undefined;
  const systemPrompt = normalizeSystemInstructions(system);

  if (messages.length === 0 && !outputText && !systemPrompt) return null;
  return {
    messages,
    systemPrompt,
    inputPayload: inputRaw,
    outputPayload: outputText,
  };
}

function normalizeLegacyIndexedGenAiMessages(attrs: Record<string, string | number | boolean>) {
  const promptIndexes = indexedAttrNumbers(attrs, "gen_ai.prompt.");
  const completionIndexes = indexedAttrNumbers(attrs, "gen_ai.completion.");
  if (promptIndexes.length === 0 && completionIndexes.length === 0) return null;

  const messages: NormalizedMessage[] = [];
  const system: string[] = [];
  for (const index of promptIndexes) {
    const role = attrs[`gen_ai.prompt.${index}.role`];
    const content = attrs[`gen_ai.prompt.${index}.content`];
    if (typeof role !== "string") continue;
    const text = normalizeLegacyContent(content);
    if (role === "system") {
      if (text) system.push(text);
    } else if (text || role === "tool") {
      const message = normalizeLegacyMessage(role, content, text);
      if (message) messages.push(message);
    }
  }

  const outputPayload = completionIndexes
    .map((index) => normalizeLegacyOutputContent(attrs[`gen_ai.completion.${index}.content`]))
    .filter(Boolean)
    .join("\n\n") || undefined;

  if (messages.length === 0 && system.length === 0 && !outputPayload) return null;
  return {
    messages,
    systemPrompt: system.join("\n\n"),
    inputPayload: promptIndexes.length
      ? JSON.stringify(promptIndexes.map((index) => ({
        role: attrs[`gen_ai.prompt.${index}.role`],
        content: attrs[`gen_ai.prompt.${index}.content`],
      })))
      : undefined,
    outputPayload,
  };
}

function normalizeLegacyMessage(role: string, rawContent: unknown, text: string): NormalizedMessage | null {
  const parsed = typeof rawContent === "string" ? parseJsonOrRaw(rawContent) : rawContent;
  if (isToolResultContent(parsed)) {
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    return {
      role: "tool",
      content: blocks.map(genAiPartContent).filter(Boolean).join("\n"),
      toolCallId: blocks.length === 1 ? toolCallIdFromPart(blocks[0]) : undefined,
      raw: parsed,
    };
  }
  if (!text && role !== "tool") return null;
  return { role: roleOrUnknown(role), content: text, raw: parsed };
}

function isToolResultContent(value: unknown): boolean {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.length > 0 && blocks.every((block) => {
    if (!block || typeof block !== "object") return false;
    const type = (block as Record<string, unknown>).type;
    return type === "tool_result" || type === "tool_call_response";
  });
}

function toolCallIdFromPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const obj = part as Record<string, unknown>;
  const id = obj.tool_use_id ?? obj.id;
  return typeof id === "string" ? id : undefined;
}

function indexedAttrNumbers(attrs: Record<string, string | number | boolean>, prefix: string): number[] {
  const indexes = new Set<number>();
  for (const key of Object.keys(attrs)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const index = Number(rest.split(".")[0]);
    if (Number.isInteger(index)) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

function messageFromGenAiObject(value: unknown): NormalizedMessage | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const role = typeof obj.role === "string" ? roleOrUnknown(obj.role) : "user";
  const content = genAiMessageContent(obj);
  if (!content && role !== "tool") return null;
  return { role, content, raw: value };
}

function genAiMessageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return extractContent(value);
  const obj = value as Record<string, unknown>;
  const parts = Array.isArray(obj.parts) ? obj.parts : Array.isArray(obj.content) ? obj.content : undefined;
  if (!parts) return extractContent(obj.content ?? value);
  return parts.map(genAiPartContent).filter(Boolean).join("\n");
}

function genAiPartContent(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const obj = part as Record<string, unknown>;
  if (obj.type === "text") return extractContent(obj);
  if (obj.type === "tool_call" || obj.type === "tool_use") {
    return JSON.stringify({
      id: obj.id,
      name: obj.name,
      arguments: obj.arguments ?? obj.input,
    });
  }
  if (obj.type === "tool_call_response" || obj.type === "tool_result") {
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.content === "string") return obj.content;
    return JSON.stringify(obj.result ?? obj.content ?? obj);
  }
  return extractContent(obj);
}

function genAiTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return extractContent(value);
  const obj = value as Record<string, unknown>;
  const parts = Array.isArray(obj.parts) ? obj.parts : Array.isArray(obj.content) ? obj.content : undefined;
  if (!parts) return extractContent(obj.content ?? value);
  return parts.map(genAiTextPartContent).filter(Boolean).join("\n");
}

function genAiTextPartContent(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const obj = part as Record<string, unknown>;
  if (
    obj.type === "tool_call" ||
    obj.type === "tool_use" ||
    obj.type === "tool_call_response" ||
    obj.type === "tool_result"
  ) {
    return "";
  }
  if (obj.type === "text") return extractContent(obj);
  return extractContent(obj);
}

function normalizeSystemInstructions(system: unknown): string {
  if (system == null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map(genAiPartContent).filter(Boolean).join("\n\n");
  return genAiPartContent(system);
}

function normalizeLegacyContent(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = parseJsonOrRaw(value);
  if (typeof parsed === "string") return parsed;
  return genAiMessageContent({ parts: Array.isArray(parsed) ? parsed : [parsed] });
}

function normalizeLegacyOutputContent(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = parseJsonOrRaw(value);
  if (typeof parsed === "string") return parsed;
  return genAiTextContent({ parts: Array.isArray(parsed) ? parsed : [parsed] });
}

/**
 * Traceloop-instrumented tool spans. `traceloop.entity.input` and
 * `traceloop.entity.output` are JSON (usually) but the discriminator is
 * `traceloop.span.kind === "tool"`. Workshop normalizes the actual tool name
 * before this adapter runs so it matches local live tool events.
 */
export const traceloopToolAdapter: SpanAdapter = {
  name: "traceloop-tool",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "TOOL_CALL") return null;
    if (input.traceloopKind !== "tool") return null;
    const argsRaw = input.attrs["traceloop.entity.input"] as string | undefined;
    const errorMessage = input.attrs["otel.status.message"] as string | undefined;
    const resultRaw = (input.attrs["traceloop.entity.output"] as string | undefined) ?? errorMessage;
    const toolName = (input.attrs["traceloop.entity.name"] as string | undefined) ?? input.spanName.replace(/\.tool$/, "");

    return {
      inputPayload: argsRaw,
      outputPayload: resultRaw,
      normalized: {
        kind: "tool",
        name: toolName,
        args: parseJsonOrRaw(argsRaw),
        result: parseJsonOrRaw(resultRaw),
        resultIsError: !!errorMessage,
      },
    };
  },
};


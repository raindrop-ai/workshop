import type { SpanAdapter, AdapterMatch } from "./types";
import type { NormalizedMessage } from "../normalized";
import { extractContent, lastUserText, parseJsonOrRaw, roleOrUnknown } from "./helpers";

/**
 * Vercel AI SDK LLM spans.
 *
 * Recognizing signal: a JSON-encoded `ai.prompt.messages` (most common), or a
 * JSON-encoded `ai.prompt` (older / Anthropic-shape calls). The JSON either
 * decodes to a flat message array or to a `{ system, messages, prompt }`
 * object — we handle both.
 *
 * If `ai.prompt` is present but isn't valid JSON, we return `null` so the
 * `claude-agent-sdk` adapter (which emits the raw task string) can claim it.
 */
export const aiSdkLlmAdapter: SpanAdapter = {
  name: "ai-sdk-llm",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "LLM_GENERATION") return null;

    const promptMessages = input.attrs["ai.prompt.messages"] as string | undefined;
    const prompt = input.attrs["ai.prompt"] as string | undefined;

    let raw: string | undefined;
    let parsed: unknown;
    for (const candidate of [promptMessages, prompt]) {
      if (typeof candidate !== "string" || !candidate) continue;
      try { parsed = JSON.parse(candidate); raw = candidate; break; } catch { /* try next */ }
    }
    if (parsed === undefined) return null;

    const messages: NormalizedMessage[] = [];
    let systemPrompt = "";

    if (Array.isArray(parsed)) {
      const sys: string[] = [];
      for (const m of parsed as Array<Record<string, unknown>>) {
        const role = (m.role as string | undefined) ?? "unknown";
        const content = extractContent(m.content);
        if (role === "system") {
          if (content) sys.push(content);
        } else if (content || role === "tool" || hasImageContent(m.content)) {
          messages.push({ role: roleOrUnknown(role), content, raw: m });
        }
      }
      if (sys.length) systemPrompt = sys.join("\n\n");
    } else if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      systemPrompt = extractSystemFromObject(p);
      if (Array.isArray(p.messages)) {
        for (const m of p.messages as Array<Record<string, unknown>>) {
          const role = (m.role as string | undefined) ?? "unknown";
          const content = extractContent(m.content);
          if (content || hasImageContent(m.content)) {
            messages.push({ role: roleOrUnknown(role), content, raw: m });
          }
        }
      }
      if (typeof p.prompt === "string" && messages.length === 0) {
        messages.push({ role: "user", content: p.prompt });
      }
    } else {
      return null;
    }

    if (messages.length === 0 && !systemPrompt) return null;

    const providerOptions = parseJsonOrRaw(input.attrs["ai.request.providerOptions"] as string | undefined);
    const model = (input.attrs["ai.model.id"] as string | undefined)
      ?? (input.attrs["ai.response.model"] as string | undefined);

    const outputPayload = (input.attrs["ai.response.text"] as string | undefined)
      ?? (input.attrs["ai.response.object"] as string | undefined)
      ?? (input.attrs["gen_ai.completion.0.content"] as string | undefined);

    return {
      inputPayload: raw,
      outputPayload,
      normalized: {
        kind: "llm",
        messages,
        userMessage: lastUserText(messages),
        systemPrompt,
        model,
        providerOptions: (providerOptions && typeof providerOptions === "object")
          ? providerOptions as Record<string, unknown>
          : undefined,
      },
    };
  },
};

function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    const part = block as Record<string, unknown>;
    if (part.type === "image") return true;
    if (part.type !== "file") return false;
    const mediaType = typeof part.mediaType === "string"
      ? part.mediaType
      : typeof part.media_type === "string"
        ? part.media_type
        : "";
    return mediaType.toLowerCase().startsWith("image/");
  });
}

/**
 * Vercel AI SDK tool-call spans.
 *
 * These have `ai.toolCall.name` plus JSON-encoded `ai.toolCall.args` /
 * `ai.toolCall.result`. We pre-parse args & result so consumers don't need
 * to JSON.parse with try/catch.
 */
export const aiSdkToolAdapter: SpanAdapter = {
  name: "ai-sdk-tool",
  apply(input): AdapterMatch | null {
    if (input.spanType !== "TOOL_CALL") return null;
    const name = input.attrs["ai.toolCall.name"] as string | undefined;
    if (!name) return null;
    const argsRaw = input.attrs["ai.toolCall.args"] as string | undefined;
    const errorMessage = input.attrs["otel.status.message"] as string | undefined;
    const resultRaw = (input.attrs["ai.toolCall.result"] as string | undefined) ?? errorMessage;

    return {
      inputPayload: argsRaw,
      outputPayload: resultRaw,
      normalized: {
        kind: "tool",
        name,
        args: parseJsonOrRaw(argsRaw),
        result: parseJsonOrRaw(resultRaw),
        resultIsError: !!errorMessage,
      },
    };
  },
};

function extractSystemFromObject(p: Record<string, unknown>): string {
  const sys = p.system;
  if (!sys) return "";
  if (typeof sys === "string") return sys;
  if (Array.isArray(sys)) {
    return sys.map(s => typeof s === "string" ? s : extractContent(s)).filter(Boolean).join("\n\n");
  }
  if (typeof sys === "object") return extractContent(sys);
  return "";
}

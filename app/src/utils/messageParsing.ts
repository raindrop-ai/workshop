import type { Span } from "./types";

export interface Message {
  role: string;
  content: string;
  /** When the original message had multiple text content blocks, each is kept separately. */
  parts?: string[];
}

/** Extract text from a content block, skipping non-text blocks (tool_use, tool_result, etc.) */
function extractText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!isRecord(c)) return "";
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (c.type === "tool_use") return "";
  if (c.type === "tool_result") return "";
  if (typeof c.text === "string") return c.text;
  if (typeof c.content === "string") return c.content;
  return "";
}

/** Extract text content from a content value (string, array of blocks, or object) */
function extractContent(content: unknown): { text: string; parts?: string[] } {
  if (typeof content === "string") return { text: content };
  if (Array.isArray(content)) {
    const parts = content.flatMap((block) => {
      const text = extractText(block);
      return text ? [text] : [];
    });
    return { text: parts.join(""), parts: parts.length > 1 ? parts : undefined };
  }
  if (isRecord(content)) {
    if (typeof content.text === "string") return { text: content.text };
    if (typeof content.content === "string") return { text: content.content };
  }
  return { text: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseMessages(raw: string | null | undefined): Message[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);

    if (isRecord(parsed) && (parsed.system || parsed.messages || parsed.prompt)) {
      const msgs: Message[] = [];
      if (parsed.system) {
        const systemMsgs = Array.isArray(parsed.system) ? parsed.system : [parsed.system];
        const text = systemMsgs.flatMap((systemMessage) => {
          const content = extractContent(systemMessage).text;
          return content ? [content] : [];
        }).join("\n\n");
        if (text) msgs.push({ role: "system", content: text });
      }
      if (Array.isArray(parsed.messages)) {
        for (const m of parsed.messages) {
          if (!isRecord(m)) continue;
          const { text, parts } = extractContent(m.content);
          const role = typeof m.role === "string" ? m.role : "unknown";
          if (text) msgs.push({ role, content: text, parts });
        }
      }
      if (typeof parsed.prompt === "string" && !parsed.messages) {
        msgs.push({ role: "user", content: parsed.prompt });
      }
      return msgs.length > 0 ? msgs : null;
    }

    if (Array.isArray(parsed)) {
      const msgs = parsed
        .map(m => {
          if (!isRecord(m)) return { role: "unknown", content: "" };
          const { text, parts } = extractContent(m.content);
          const role = typeof m.role === "string" ? m.role : "unknown";
          return { role, content: text, parts };
        })
        .filter(m => m.content);
      return msgs.length > 0 ? msgs : null;
    }
  } catch { /* not JSON */ }
  return null;
}

function extractPartsFromRaw(raw: unknown): string[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const content = (raw as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") { if (block) parts.push(block); }
    else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text) parts.push(b.text);
    }
  }
  return parts.length > 1 ? parts : undefined;
}

export function messagesFromSpan(span: Pick<Span, "input_payload" | "normalized">): Message[] | null {
  if (span.normalized?.kind === "llm") {
    const out: Message[] = [];
    if (span.normalized.systemPrompt) {
      out.push({ role: "system", content: span.normalized.systemPrompt });
    }
    for (const m of span.normalized.messages) {
      out.push({ role: m.role, content: m.content, parts: extractPartsFromRaw(m.raw) });
    }
    return out.length > 0 ? out : null;
  }
  return parseMessages(span.input_payload);
}

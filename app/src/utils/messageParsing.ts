import type { Span } from "./types";

export interface Message {
  role: string;
  content: string;
  /** When the original message had multiple text content blocks, each is kept separately. */
  parts?: string[];
  /** Displayable `<img>` srcs (URLs or data URIs) for any image/file image content blocks. */
  images?: string[];
}

/** Extract text from a content block, skipping non-text blocks (tool_use, tool_result, etc.) */
function extractText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!isRecord(c)) return "";
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (c.type === "tool_use") return "";
  if (c.type === "tool_result") return "";
  if (c.type === "image" || c.type === "file") return "";
  if (typeof c.text === "string") return c.text;
  if (typeof c.content === "string") return c.content;
  return "";
}

function mediaTypeOf(c: Record<string, unknown>): string | undefined {
  if (typeof c.mediaType === "string") return c.mediaType;
  if (typeof c.media_type === "string") return c.media_type;
  return undefined;
}

function toImageSrc(value: string, mediaType?: string): string {
  if (value.startsWith("http") || value.startsWith("data:")) return value;
  const mt = mediaType && mediaType.startsWith("image/") && mediaType !== "image/*" ? mediaType : "image/png";
  return `data:${mt};base64,${value}`;
}

/**
 * Pull a displayable `<img>` src out of an image/file content block, or null
 * for non-image blocks. Handles the AI SDK shapes (`{type:"image",image}`,
 * `{type:"file",mediaType:"image/*",data}`) and Anthropic's `{type:"image",source}`.
 */
function extractImageSrc(c: unknown): string | null {
  if (!isRecord(c)) return null;

  if (c.type === "image") {
    if (typeof c.image === "string") return toImageSrc(c.image, mediaTypeOf(c));
    if (isRecord(c.image) && typeof c.image.url === "string") return c.image.url;
    if (isRecord(c.source)) {
      const src = c.source;
      if (src.type === "url" && typeof src.url === "string") return src.url;
      if (typeof src.data === "string") {
        const mt = typeof src.media_type === "string" ? src.media_type : undefined;
        return toImageSrc(src.data, mt);
      }
    }
    return null;
  }

  if (c.type === "file") {
    const mt = mediaTypeOf(c);
    if (!mt || !mt.startsWith("image")) return null;
    const data = typeof c.data === "string" ? c.data : typeof c.url === "string" ? c.url : null;
    return data ? toImageSrc(data, mt) : null;
  }

  return null;
}

function extractImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content.flatMap((block) => {
    const src = extractImageSrc(block);
    return src ? [src] : [];
  });
  return images.length > 0 ? images : undefined;
}

/** Extract text content from a content value (string, array of blocks, or object) */
function extractContent(content: unknown): { text: string; parts?: string[]; images?: string[] } {
  if (typeof content === "string") return { text: content };
  if (Array.isArray(content)) {
    const parts = content.flatMap((block) => {
      const text = extractText(block);
      return text ? [text] : [];
    });
    return { text: parts.join(""), parts: parts.length > 1 ? parts : undefined, images: extractImages(content) };
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
          const { text, parts, images } = extractContent(m.content);
          const role = typeof m.role === "string" ? m.role : "unknown";
          if (text || images) msgs.push({ role, content: text, parts, images });
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
          const { text, parts, images } = extractContent(m.content);
          const role = typeof m.role === "string" ? m.role : "unknown";
          return { role, content: text, parts, images };
        })
        .filter(m => m.content || m.images);
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

function extractImagesFromRaw(raw: unknown): string[] | undefined {
  if (!isRecord(raw)) return undefined;
  return extractImages(raw.content);
}

export function messagesFromSpan(span: Pick<Span, "input_payload" | "normalized">): Message[] | null {
  if (span.normalized?.kind === "llm") {
    const out: Message[] = [];
    if (span.normalized.systemPrompt) {
      out.push({ role: "system", content: span.normalized.systemPrompt });
    }
    for (const m of span.normalized.messages) {
      out.push({ role: m.role, content: m.content, parts: extractPartsFromRaw(m.raw), images: extractImagesFromRaw(m.raw) });
    }
    return out.length > 0 ? out : null;
  }
  return parseMessages(span.input_payload);
}

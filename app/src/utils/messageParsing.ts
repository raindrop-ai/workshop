import type { Span } from "./types";

export interface Message {
  role: string;
  content: string;
  /** When the original message had multiple text content blocks, each is kept separately. */
  parts?: string[];
  /** Safe browser image sources recovered from image content blocks. */
  images?: string[];
}

/** Edit & replay currently accepts text only, so image-bearing turns cannot be edited faithfully. */
export function canEditReplayMessage(message: Pick<Message, "images">): boolean {
  return !message.images?.length;
}

const MAX_INLINE_IMAGE_BASE64_CHARS = 10 * 1024 * 1024;
const SAFE_INLINE_IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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

function safeInlineMediaType(mediaType?: string): string | null {
  const normalized = mediaType?.trim().toLowerCase();
  if (!normalized || normalized === "image/*") return "image/png";
  return SAFE_INLINE_IMAGE_MEDIA_TYPES.has(normalized) ? normalized : null;
}

function normalizeBase64(value: string): string | null {
  if (value.length > MAX_INLINE_IMAGE_BASE64_CHARS) return null;
  const compact = value.replace(/\s/g, "");
  if (
    !compact
    || compact.length > MAX_INLINE_IMAGE_BASE64_CHARS
    || compact.length % 4 === 1
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) return null;
  return compact;
}

function safeRemoteImageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function toImageSrc(value: string, mediaType?: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^https?:/i.test(trimmed)) return safeRemoteImageUrl(trimmed);

  if (/^data:/i.test(trimmed)) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(trimmed);
    if (!match) return null;
    const safeMediaType = safeInlineMediaType(match[1]);
    const base64 = normalizeBase64(match[2]);
    return safeMediaType && base64 ? `data:${safeMediaType};base64,${base64}` : null;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;

  const safeMediaType = safeInlineMediaType(mediaType);
  const base64 = normalizeBase64(trimmed);
  return safeMediaType && base64 ? `data:${safeMediaType};base64,${base64}` : null;
}

/** Extract a safe browser source from common AI SDK and Anthropic image parts. */
function extractImageSrc(c: unknown): string | null {
  if (!isRecord(c)) return null;

  if (c.type === "image") {
    if (typeof c.image === "string") return toImageSrc(c.image, mediaTypeOf(c));
    if (isRecord(c.image) && typeof c.image.url === "string") {
      return toImageSrc(c.image.url, mediaTypeOf(c));
    }
    if (isRecord(c.source)) {
      if (c.source.type === "url" && typeof c.source.url === "string") {
        return toImageSrc(c.source.url);
      }
      if (typeof c.source.data === "string") {
        const mediaType = typeof c.source.media_type === "string" ? c.source.media_type : undefined;
        return toImageSrc(c.source.data, mediaType);
      }
    }
    return null;
  }

  if (c.type === "file") {
    const mediaType = mediaTypeOf(c);
    if (!mediaType || !mediaType.toLowerCase().startsWith("image/")) return null;
    const data = typeof c.data === "string" ? c.data : typeof c.url === "string" ? c.url : null;
    return data ? toImageSrc(data, mediaType) : null;
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
      const msgs: Message[] = [];
      for (const m of parsed) {
        if (!isRecord(m)) continue;
        const { text, parts, images } = extractContent(m.content);
        const role = typeof m.role === "string" ? m.role : "unknown";
        if (text || images) msgs.push({ role, content: text, parts, images });
      }
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

function hasImagePartInRaw(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.content)) return false;
  return raw.content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "image") return true;
    return block.type === "file" && mediaTypeOf(block)?.toLowerCase().startsWith("image/");
  });
}

export function messagesFromSpan(span: Pick<Span, "input_payload" | "normalized">): Message[] | null {
  if (span.normalized?.kind === "llm") {
    const out: Message[] = [];
    if (span.normalized.systemPrompt) {
      out.push({ role: "system", content: span.normalized.systemPrompt });
    }
    for (const m of span.normalized.messages) {
      const parts = extractPartsFromRaw(m.raw);
      const images = extractImagesFromRaw(m.raw);
      if (
        m.role !== "tool"
        && !m.content
        && !parts?.length
        && !images?.length
        && hasImagePartInRaw(m.raw)
      ) continue;
      out.push({
        role: m.role,
        content: m.content,
        parts,
        images,
      });
    }
    return out.length > 0 ? out : null;
  }
  return parseMessages(span.input_payload);
}

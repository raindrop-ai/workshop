import { spawnSync } from "node:child_process";
import type {
  ClaudeChatMessage,
  ClaudeChatMessageBlock,
  ClaudeSessionDetail,
  ClaudeSessionSummary,
} from "./claude-sessions";

interface OpencodeSessionListRow {
  id?: unknown;
  title?: unknown;
  updated?: unknown;
  created?: unknown;
  directory?: unknown;
}

interface OpencodeExport {
  info?: {
    id?: unknown;
    title?: unknown;
    directory?: unknown;
    time?: {
      created?: unknown;
      updated?: unknown;
    };
  };
  messages?: unknown;
}

export function listOpencodeSessions(cwd: string): ClaudeSessionSummary[] {
  const output = execOpenCode(["session", "list", "--format", "json"]);
  return parseSessionList(output, cwd);
}

function parseSessionList(output: string, cwd: string): ClaudeSessionSummary[] {
  if (!output.trim()) return [];
  const rows = parseJson<OpencodeSessionListRow[]>(output);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => typeof row.directory === "string" && row.directory === cwd && typeof row.id === "string")
    .map((row) => ({
      id: row.id as string,
      path: "",
      cwd,
      created_at: timestampString(row.created),
      updated_at: timestampString(row.updated),
      message_count: 0,
      last_prompt: null,
      preview: typeof row.title === "string" ? row.title : null,
    }));
}

export function getOpencodeSession(cwd: string, sessionId: string): ClaudeSessionDetail | null {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const output = execOpenCode(["export", sessionId]);
  const parsed = parseExport(output);
  if (!parsed?.info || parsed.info.directory !== cwd || parsed.info.id !== sessionId) return null;
  const messages = parseMessages(parsed.messages);
  const previewMessage = [...messages].reverse().find((message) => message.role === "user") ?? messages[messages.length - 1];
  const lastPrompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? null;
  return {
    id: sessionId,
    path: "",
    cwd,
    created_at: timestampString(parsed.info.time?.created),
    updated_at: timestampString(parsed.info.time?.updated),
    message_count: messages.length,
    last_prompt: lastPrompt,
    preview: previewText(lastPrompt || previewMessage?.content || valueString(parsed.info.title) || null),
    messages,
  };
}

function parseMessages(value: unknown): ClaudeChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ClaudeChatMessage[] = [];
  for (const raw of value) {
    const typed = objectValue(raw);
    const info = objectValue(typed?.info);
    const role = info?.role === "user" || info?.role === "assistant" ? info.role : null;
    if (!role) continue;
    const blocks = parseParts(typed?.parts);
    const content = blocksText(blocks);
    if (!content && blocks.length === 0) continue;
    messages.push({
      id: valueString(info?.id) ?? `opencode-${messages.length}`,
      role,
      content,
      blocks: blocks.length ? blocks : undefined,
      timestamp: timestampString(objectValue(info?.time)?.created),
    });
  }
  return messages;
}

function parseParts(value: unknown): ClaudeChatMessageBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: ClaudeChatMessageBlock[] = [];
  for (const raw of value) {
    const part = objectValue(raw);
    if (!part) continue;
    const type = valueString(part?.type);
    if (!type) continue;
    if (type === "text") {
      const text = valueString(part.text);
      if (text) blocks.push({ type: "text", text });
      continue;
    }
    if (type === "thinking" || type === "reasoning") {
      const text = valueString(part.text) ?? valueString(part.reasoning) ?? valueString(part.content);
      if (text) blocks.push({ type: "thinking", text });
      continue;
    }
    const toolName =
      valueString(part.name) ??
      valueString(part.tool) ??
      valueString(objectValue(part.call)?.name) ??
      valueString(objectValue(part.toolCall)?.name);
    if (type.includes("tool") || toolName) {
      blocks.push({
        type: "tool",
        id: valueString(part.id) ?? `${toolName ?? "tool"}-${blocks.length}`,
        name: toolName ?? "tool",
        input_preview: previewValue(part.input ?? objectValue(part.call)?.input ?? objectValue(part.toolCall)?.input),
        output_preview: previewValue(part.output ?? objectValue(part.result)?.output ?? part.result),
        ok: part.error !== true,
      });
    }
  }
  return blocks;
}

function blocksText(blocks: ClaudeChatMessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      return `[tool: ${block.name}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function previewText(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function timestampString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function parseExport(text: string): OpencodeExport | null {
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) return null;
  return parseJson<OpencodeExport>(text.slice(jsonStart));
}

function execOpenCode(args: string[]): string {
  const result = spawnSync(process.env.RAINDROP_WORKSHOP_OPENCODE_BIN ?? "opencode", args, {
    env: process.env,
    encoding: "utf8",
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function valueString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export const _internal = {
  parseExport,
  parseSessionList,
  parseMessages,
};

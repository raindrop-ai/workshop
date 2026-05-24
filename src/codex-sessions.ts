import fs from "fs";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import type {
  ClaudeChatMessage,
  ClaudeChatMessageBlock,
  ClaudeSessionDetail,
  ClaudeSessionSummary,
} from "./claude-sessions";

const MAX_SESSION_FILES = 300;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function listCodexSessions(cwd?: string | null): ClaudeSessionSummary[] {
  return codexSessionFiles()
    .map((file) => readCodexSessionFile(file))
    .filter((session): session is ClaudeSessionDetail => {
      if (!session || session.message_count === 0) return false;
      return !cwd || session.cwd === cwd;
    })
    .sort((a, b) => (Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0))
    .map(({ messages: _messages, ...summary }) => summary);
}

export function getCodexSession(sessionId: string, cwd?: string | null): ClaudeSessionDetail | null {
  const file = findCodexSessionFile(sessionId, cwd);
  return file ? readCodexSessionFile(file) : null;
}

export function forkCodexSession(sourceSessionId: string): ClaudeSessionSummary | null {
  const sourceFile = findCodexSessionFile(sourceSessionId);
  if (!sourceFile) return null;

  const forkId = randomUUID();
  const now = new Date();
  const forkPath = codexSessionPath(now, forkId);
  let forkedCurrentSessionMeta = false;
  const forkedLines = fs
    .readFileSync(sourceFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      if (forkedCurrentSessionMeta || !isSessionMetaLine(line)) return line;
      forkedCurrentSessionMeta = true;
      return forkCodexSessionLine(line, forkId, now, sourceSessionId);
    });

  fs.mkdirSync(path.dirname(forkPath), { recursive: true });
  fs.writeFileSync(forkPath, `${forkedLines.join("\n")}\n`);

  return readCodexSessionFile(forkPath);
}

function codexSessionFiles(): string[] {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const files: string[] = [];
  collectJsonlFiles(root, files);
  return files
    .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a))
    .slice(0, MAX_SESSION_FILES);
}

function findCodexSessionFile(sessionId: string, cwd?: string | null): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  for (const file of codexSessionFiles()) {
    if (!path.basename(file).endsWith(`${sessionId}.jsonl`)) continue;
    const session = readCodexSessionFile(file);
    if (session?.id === sessionId && (!cwd || session.cwd === cwd)) return file;
  }
  return null;
}

function codexSessionPath(date: Date, sessionId: string): string {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "").replace(/:/g, "-");
  return path.join(root, year, month, day, `rollout-${stamp}-${sessionId}.jsonl`);
}

function forkCodexSessionLine(line: string, forkId: string, now: Date, sourceSessionId: string): string {
  const event = parseLine(line);
  if (!event || event.type !== "session_meta") return line;

  const payload = objectValue(event.payload);
  if (!payload) return line;

  event.timestamp = now.toISOString();
  event.payload = {
    ...payload,
    id: forkId,
    timestamp: now.toISOString(),
    forked_from_id: sourceSessionId,
    originator: "workshop_codex_fork",
  };
  return JSON.stringify(event);
}

function isSessionMetaLine(line: string): boolean {
  return parseLine(line)?.type === "session_meta";
}

function collectJsonlFiles(dir: string, files: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(next, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(next);
  }
}

function readCodexSessionFile(filePath: string): ClaudeSessionDetail | null {
  if (!fs.existsSync(filePath)) return null;
  const messages: ClaudeChatMessage[] = [];
  const toolBlocks = new Map<string, Extract<ClaudeChatMessageBlock, { type: "tool" }>>();
  let id = "";
  let cwd = "";
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastPrompt: string | null = null;
  let threadSource: string | null = null;
  let currentSessionMetaRead = false;
  let assistantBlocks: ClaudeChatMessageBlock[] = [];
  let assistantTimestamp: string | null = null;

  const flushAssistant = () => {
    if (!assistantBlocks.length) return;
    const content = assistantBlocksText(assistantBlocks);
    if (content.trim()) {
      messages.push({
        id: `${id || path.basename(filePath, ".jsonl")}-${messages.length}`,
        role: "assistant",
        content,
        blocks: assistantBlocks,
        timestamp: assistantTimestamp,
      });
    }
    assistantBlocks = [];
    assistantTimestamp = null;
  };

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const event = parseLine(line);
    if (!event) continue;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }

    if (event.type === "session_meta") {
      if (!currentSessionMetaRead) {
        const payload = objectValue(event.payload);
        if (typeof payload?.id === "string") id = payload.id;
        if (typeof payload?.cwd === "string") cwd = payload.cwd;
        if (typeof payload?.thread_source === "string") threadSource = payload.thread_source;
        currentSessionMetaRead = true;
      }
      continue;
    }

    if (event.type !== "response_item") continue;
    const payload = objectValue(event.payload);
    if (!payload) continue;

    if (payload.type === "message") {
      const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
      if (!role) continue;
      const rawContent = contentText(payload.content);
      if (role === "user") {
        flushAssistant();
        const content = stripWorkshopContext(rawContent);
        if (!content.trim() || isCodexContextUserMessage(content)) continue;
        lastPrompt = content;
        messages.push({
          id: `${id || path.basename(filePath, ".jsonl")}-${messages.length}`,
          role,
          content,
          blocks: [{ type: "text", text: content }],
          timestamp,
        });
        continue;
      }

      const content = stripWorkshopContext(rawContent);
      if (!content.trim()) continue;
      assistantBlocks.push({ type: "text", text: content });
      assistantTimestamp ??= timestamp;
      continue;
    }

    if (payload.type === "function_call") {
      const callId = stringValue(payload.call_id) ?? `${messages.length}-${assistantBlocks.length}`;
      const block: Extract<ClaudeChatMessageBlock, { type: "tool" }> = {
        type: "tool",
        id: callId,
        name: codexToolName(payload),
        input_preview: previewText(stringValue(payload.arguments)) ?? undefined,
      };
      toolBlocks.set(callId, block);
      assistantBlocks.push(block);
      assistantTimestamp ??= timestamp;
      continue;
    }

    if (payload.type === "function_call_output") {
      const callId = stringValue(payload.call_id);
      const block = callId ? toolBlocks.get(callId) : null;
      if (block) {
        block.ok = true;
        block.output_preview = previewText(stringValue(payload.output)) ?? undefined;
      }
    }
  }
  flushAssistant();

  if (!id || !cwd || threadSource === "subagent") return null;
  const previewMessage = [...messages].reverse().find((message) => message.role === "user") ?? messages[messages.length - 1];
  return {
    id,
    path: filePath,
    cwd,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messages.length,
    last_prompt: lastPrompt,
    preview: previewText(lastPrompt || previewMessage?.content || null),
    messages,
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const typed = objectValue(part);
      return typeof typed?.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isCodexContextUserMessage(content: string): boolean {
  return (
    content.startsWith("# AGENTS.md instructions") ||
    content.startsWith("<subagent_notification>") ||
    content.startsWith("<turn_aborted>") ||
    content.startsWith("<goal_")
  );
}

function stripWorkshopContext(content: string): string {
  const envelopeIndex = content.indexOf("<workshop_message>");
  if (envelopeIndex >= 0) {
    return content.slice(envelopeIndex).replace(/^<workshop_message>[\s\S]*?<\/workshop_message>\s*/m, "").trim();
  }
  return content.trim();
}

function previewText(value: string | null): string | null {
  if (!value) return null;
  const compact = value
    .replace(/<image\b[^>]*>\s*<\/image>/gi, " ")
    .replace(/\[Image #[0-9]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function assistantBlocksText(blocks: ClaudeChatMessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      return `[tool: ${block.name}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function codexToolName(payload: Record<string, unknown>): string {
  const name = stringValue(payload.name) ?? "tool";
  const namespace = stringValue(payload.namespace);
  if (namespace === "mcp__raindrop__") return `raindrop.${name}`;
  return namespace ? `${namespace}.${name}` : name;
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

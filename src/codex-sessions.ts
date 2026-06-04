import fs from "fs";
import os from "os";
import path from "path";
import type {
  ClaudeChatMessage,
  ClaudeChatMessageBlock,
  ClaudeSessionDetail,
  ClaudeSessionSummary,
} from "./claude-sessions";

const MAX_SESSION_FILES = 300;

export function listCodexSessions(cwd: string): ClaudeSessionSummary[] {
  return codexSessionFiles()
    .map((file) => readCodexSessionFile(file))
    .filter((session): session is ClaudeSessionDetail => !!session && session.cwd === cwd)
    .sort((a, b) => (Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0))
    .map(({ messages: _messages, ...summary }) => summary);
}

export function getCodexSession(cwd: string, sessionId: string): ClaudeSessionDetail | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  for (const file of codexSessionFiles()) {
    if (!path.basename(file).includes(sessionId)) continue;
    const session = readCodexSessionFile(file);
    if (session?.cwd === cwd && session.id === sessionId) return session;
  }
  return null;
}

function codexSessionFiles(): string[] {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const files: string[] = [];
  collectJsonlFiles(root, files);
  return files
    .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a))
    .slice(0, MAX_SESSION_FILES);
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
  let workshopTurnOpen = false;
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
      const payload = objectValue(event.payload);
      if (typeof payload?.id === "string") id = payload.id;
      if (typeof payload?.cwd === "string") cwd = payload.cwd;
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
        if (!isWorkshopUserMessage(rawContent)) {
          workshopTurnOpen = false;
          continue;
        }
        const content = stripWorkshopContext(rawContent);
        if (!content.trim()) continue;
        lastPrompt = content;
        workshopTurnOpen = true;
        messages.push({
          id: `${id || path.basename(filePath, ".jsonl")}-${messages.length}`,
          role,
          content,
          blocks: [{ type: "text", text: content }],
          timestamp,
        });
        continue;
      }

      if (!workshopTurnOpen) continue;
      const content = stripWorkshopContext(rawContent);
      if (!content.trim()) continue;
      assistantBlocks.push({ type: "text", text: content });
      assistantTimestamp ??= timestamp;
      continue;
    }

    if (!workshopTurnOpen) continue;
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

  if (!id || !cwd) return null;
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

function isWorkshopUserMessage(content: string): boolean {
  return content.includes("<workshop_message>") || content.includes("Raindrop Workshop chat pane");
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
  const compact = value.replace(/\s+/g, " ").trim();
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
  if (namespace === "mcp__workshop__" || namespace === "mcp__raindrop__") return `workshop.${name}`;
  return namespace ? `${namespace}.${name}` : name;
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

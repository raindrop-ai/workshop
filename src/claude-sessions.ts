import fs from "fs";
import os from "os";
import path from "path";

type ClaudeChatRole = "user" | "assistant";

export interface ClaudeChatMessage {
  id: string;
  role: ClaudeChatRole;
  content: string;
  blocks?: ClaudeChatMessageBlock[];
  timestamp: string | null;
  error?: string;
}

export type ClaudeChatMessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; input_preview?: string; output_preview?: string; ok?: boolean };

export interface ClaudeSessionSummary {
  id: string;
  path: string;
  cwd: string;
  title?: string | null;
  created_at: string | null;
  updated_at: string | null;
  message_count: number;
  loaded_message_count?: number;
  messages_truncated?: boolean;
  last_prompt: string | null;
  preview: string | null;
}

export interface ClaudeSessionDetail extends ClaudeSessionSummary {
  messages: ClaudeChatMessage[];
}

export interface ClaudeLoadout {
  tools: string[];
  mcps: string[];
  skills: string[];
  plugins: string[];
  slash_commands?: string[];
  model?: string;
}

function projectSessionDir(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", encodeClaudeProjectPath(cwd));
}

export function listClaudeSessions(cwd: string): ClaudeSessionSummary[] {
  const dir = projectSessionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readClaudeSessionFile(path.join(dir, name)))
    .filter((session): session is ClaudeSessionDetail => !!session)
    .sort((a, b) => (Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0))
    .map((session) => ({ ...session, cwd }))
    .map(({ messages: _messages, ...summary }) => summary);
}

export function getClaudeSession(cwd: string, sessionId: string): ClaudeSessionDetail | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  const session = readClaudeSessionFile(path.join(projectSessionDir(cwd), `${sessionId}.jsonl`));
  return session ? { ...session, cwd } : null;
}

export function getLatestClaudeLoadout(cwd: string): ClaudeLoadout | null {
  const dir = projectSessionDir(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 20);

  for (const file of files) {
    const loadout = readClaudeLoadoutFile(file);
    if (loadout) return loadout;
  }
  return null;
}

function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function readClaudeLoadoutFile(filePath: string): ClaudeLoadout | null {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseLine(lines[i]);
    const attachment = event?.attachment;
    if (!attachment || typeof attachment !== "object") continue;
    const typed = attachment as Record<string, unknown>;
    if (typed.type !== "skill_listing" || typeof typed.content !== "string") continue;
    const skills = parseSkillListing(typed.content);
    if (skills.length) {
      return {
        tools: [],
        mcps: [],
        skills,
        plugins: [],
        slash_commands: [],
      };
    }
  }
  return null;
}

function parseSkillListing(content: string): string[] {
  const skills = new Set<string>();
  for (const match of content.matchAll(/^\s*-\s+([A-Za-z0-9:_-]+):\s+/gm)) {
    skills.add(match[1]);
  }
  return [...skills];
}

function readClaudeSessionFile(filePath: string): ClaudeSessionDetail | null {
  if (!fs.existsSync(filePath)) return null;
  const id = path.basename(filePath, ".jsonl");
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const messages: ClaudeChatMessage[] = [];
  const toolBlocks = new Map<string, Extract<ClaudeChatMessageBlock, { type: "tool" }>>();
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastPrompt: string | null = null;

  for (const line of lines) {
    const event = parseLine(line);
    if (!event) continue;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }
    if (event.type === "last-prompt" && typeof event.lastPrompt === "string") {
      lastPrompt = stripWorkshopEnvelope(event.lastPrompt);
      continue;
    }
    if (event.type !== "user" && event.type !== "assistant") continue;
    const toolResults = messageToolResults(event.message);
    if (toolResults.length) {
      for (const result of toolResults) {
        const tool = toolBlocks.get(result.tool_use_id);
        if (!tool) continue;
        tool.output_preview = result.output_preview;
        tool.ok = result.ok;
      }
      if (isOnlyToolResultMessage(event.message)) continue;
    }
    const blocks = messageBlocks(event.message);
    const content = blocksText(blocks);
    if (!content && !blocks.length) continue;
    const visibleContent = stripWorkshopEnvelope(content);
    if (!visibleContent && !blocks.length) continue;
    for (const block of blocks) {
      if (block.type === "tool") toolBlocks.set(block.id, block);
    }
    const claudeMessageId = event.type === "assistant" ? messageId(event.message) : null;
    const nextMessage: ClaudeChatMessage = {
      id: claudeMessageId ?? (typeof event.uuid === "string" ? event.uuid : `${id}-${messages.length}`),
      role: event.type,
      content: visibleContent,
      blocks: blocks.length ? blocks : undefined,
      timestamp,
      error: typeof event.error === "string" ? event.error : undefined,
    };
    const previous = messages[messages.length - 1];
    if (event.type === "assistant" && claudeMessageId && previous?.id === claudeMessageId) {
      const mergedBlocks = [...(previous.blocks ?? []), ...blocks];
      previous.blocks = mergedBlocks.length ? mergedBlocks : undefined;
      previous.content = stripWorkshopEnvelope(blocksText(mergedBlocks)) || previous.content || visibleContent;
      previous.timestamp = timestamp ?? previous.timestamp;
      previous.error = previous.error ?? nextMessage.error;
      continue;
    }
    messages.push(nextMessage);
  }

  const previewMessage = [...messages].reverse().find((message) => message.role === "user") ?? messages[messages.length - 1];
  return {
    id,
    path: filePath,
    cwd: "",
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

function messageBlocks(raw: unknown): ClaudeChatMessageBlock[] {
  if (!raw || typeof raw !== "object") return [];
  const message = raw as Record<string, unknown>;
  if (typeof message.content === "string") {
    return message.content.trim() ? [{ type: "text", text: message.content }] : [];
  }
  if (!Array.isArray(message.content)) return [];
  const blocks: ClaudeChatMessageBlock[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim()) {
      blocks.push({ type: "text", text: typed.text });
    }
    if (typed.type === "thinking" && typeof typed.thinking === "string" && typed.thinking.trim()) {
      blocks.push({ type: "thinking", text: typed.thinking });
    }
    if (typed.type === "tool_use" && typeof typed.name === "string") {
      const id = typeof typed.id === "string" ? typed.id : `${typed.name}-${blocks.length}`;
      blocks.push({
        type: "tool",
        id,
        name: typed.name,
        input_preview: previewValue(typed.input),
      });
    }
  }
  return blocks;
}

function messageId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

function blocksText(blocks: ClaudeChatMessageBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    if (block.type === "tool") parts.push(`[tool: ${block.name}]`);
  }
  return parts.join("\n");
}

function messageToolResults(raw: unknown): Array<{ tool_use_id: string; output_preview?: string; ok: boolean }> {
  if (!raw || typeof raw !== "object") return [];
  const content = (raw as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const results: Array<{ tool_use_id: string; output_preview?: string; ok: boolean }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type !== "tool_result" || typeof typed.tool_use_id !== "string") continue;
    results.push({
      tool_use_id: typed.tool_use_id,
      output_preview: previewValue(typed.content),
      ok: typed.is_error !== true,
    });
  }
  return results;
}

function isOnlyToolResultMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const content = (raw as Record<string, unknown>).content;
  return Array.isArray(content) && content.length > 0 && content.every((block) => {
    return !!block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result";
  });
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function previewText(text: string | null): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}

function stripWorkshopEnvelope(text: string): string {
  return text
    .replace(/<workshop_message>[\s\S]*?<\/workshop_message>\s*/g, "")
    .trim();
}

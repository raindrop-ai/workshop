import fs from "fs";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import { Database } from "bun:sqlite";
import type {
  ClaudeChatMessage,
  ClaudeChatMessageBlock,
  ClaudeSessionDetail,
  ClaudeSessionSummary,
} from "./claude-sessions";

const MAX_SESSION_FILES = 300;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_DETAIL_MESSAGE_LIMIT = 120;

interface CodexSessionReadOptions {
  messageLimit?: number;
}

export function listCodexSessions(cwd?: string | null): ClaudeSessionSummary[] {
  const metadata = readCodexSessionMetadata();
  return codexSessionFiles()
    .map((file) => readCodexSessionSummaryFile(file, metadata))
    .filter((session): session is ClaudeSessionSummary => {
      if (!session || session.message_count === 0) return false;
      return !cwd || session.cwd === cwd;
    })
    .sort((a, b) => (Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0))
}

export function getCodexSession(
  sessionId: string,
  cwd?: string | null,
  options: CodexSessionReadOptions = {},
): ClaudeSessionDetail | null {
  const metadata = readCodexSessionMetadata();
  const file = findCodexSessionFile(sessionId, cwd, metadata);
  return file ? readCodexSessionFile(file, metadata, options) : null;
}

export function forkCodexSession(sourceSessionId: string): ClaudeSessionSummary | null {
  const metadata = readCodexSessionMetadata();
  const sourceFile = findCodexSessionFile(sourceSessionId, null, metadata);
  if (!sourceFile) return null;
  const source = readCodexSessionSummaryFile(sourceFile, metadata);

  const forkId = randomUUID();
  const now = new Date();
  const forkPath = codexSessionPath(now, forkId);
  const sourceTitle = source?.title ?? source?.preview ?? `Codex chat ${sourceSessionId.slice(0, 8)}`;
  const forkTitle = nextForkedCodexTitle(sourceTitle, sourceFile);
  let forkedCurrentSessionMeta = false;
  const forkedLines = fs
    .readFileSync(sourceFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      if (forkedCurrentSessionMeta || !isSessionMetaLine(line)) return line;
      forkedCurrentSessionMeta = true;
      return forkCodexSessionLine(line, forkId, now, sourceSessionId, forkTitle);
    });

  fs.mkdirSync(path.dirname(forkPath), { recursive: true });
  fs.writeFileSync(forkPath, `${forkedLines.join("\n")}\n`);
  writeForkedCodexSqliteMetadata(sourceSessionId, forkId, forkPath, forkTitle, now);

  return readCodexSessionSummaryFile(forkPath, readCodexSessionMetadata());
}

export function ensureForkedCodexSessionTitle(
  sessionId: string,
  expectedTitle?: string | null,
): ClaudeSessionSummary | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;

  const metadata = readCodexSessionMetadata();
  const file = findCodexSessionFile(sessionId, null, metadata);
  if (!file) return null;

  const forkMetadata = readForkedCodexMetadata(file);
  if (!expectedTitle && !forkMetadata?.isFork) {
    return readCodexSessionSummaryFile(file, metadata);
  }

  const title = storedForkedCodexTitle(expectedTitle ?? forkMetadata?.title ?? `Codex chat ${sessionId.slice(0, 8)}`, file);
  updateForkedCodexSessionLine(file, sessionId, title);
  updateCodexSqliteForkTitle(sessionId, title);
  return readCodexSessionSummaryFile(file, readCodexSessionMetadata());
}

function codexSessionFiles(): string[] {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const files: string[] = [];
  collectJsonlFiles(root, files);
  return files
    .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a))
    .slice(0, MAX_SESSION_FILES);
}

function findCodexSessionFile(
  sessionId: string,
  cwd?: string | null,
  metadata = readCodexSessionMetadata(),
): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  for (const file of codexSessionFiles()) {
    if (!path.basename(file).endsWith(`${sessionId}.jsonl`)) continue;
    const session = readCodexSessionSummaryFile(file, metadata);
    if (session?.id === sessionId && (!cwd || session.cwd === cwd)) return file;
  }
  return null;
}

function findCodexSessionFileById(sessionId: string): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  for (const file of codexSessionFiles()) {
    if (path.basename(file).endsWith(`${sessionId}.jsonl`)) return file;
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

function forkCodexSessionLine(
  line: string,
  forkId: string,
  now: Date,
  sourceSessionId: string,
  forkTitle: string,
): string {
  const event = parseLine(line);
  if (!event || event.type !== "session_meta") return line;

  const payload = objectValue(event.payload);
  if (!payload) return line;

  event.timestamp = now.toISOString();
  event.payload = {
    ...payload,
    id: forkId,
    timestamp: now.toISOString(),
    title: forkTitle,
    forked_from_id: sourceSessionId,
    originator: "workshop_codex_fork",
    workshop_title: forkTitle,
    workshop_visible_after: now.toISOString(),
  };
  return JSON.stringify(event);
}

function nextForkedCodexTitle(title: string | null, sourceFilePath: string): string {
  const cleaned = (title || "Untitled chat").replace(/\s+/g, " ").trim();
  const parsed = parseForkedTitle(cleaned);
  return formatForkedTitle(Math.max(parsed.depth, forkDepthForFile(sourceFilePath)) + 1, parsed.base);
}

function storedForkedCodexTitle(title: string | null, filePath: string): string {
  const cleaned = (title || "Untitled chat").replace(/\s+/g, " ").trim();
  const parsed = parseForkedTitle(cleaned);
  return formatForkedTitle(Math.max(1, parsed.depth, forkDepthForFile(filePath)), parsed.base);
}

function parseForkedTitle(title: string): { depth: number; base: string } {
  const match = title.match(/^\[forked(?:\^(\d+))?\]\s*(.*)$/i);
  if (!match) return { depth: 0, base: title || "Untitled chat" };
  const depth = match[1] ? Number.parseInt(match[1], 10) : 1;
  return {
    depth: Number.isFinite(depth) && depth > 0 ? depth : 1,
    base: match[2]?.trim() || "Untitled chat",
  };
}

function formatForkedTitle(depth: number, base: string): string {
  const cleanBase = base.replace(/\s+/g, " ").trim() || "Untitled chat";
  return depth <= 1 ? `[forked] ${cleanBase}` : `[forked^${depth}] ${cleanBase}`;
}

function forkDepthForFile(filePath: string, seen = new Set<string>()): number {
  const metadata = readForkedCodexMetadata(filePath);
  if (!metadata?.isFork) return 0;
  if (!metadata.parentId || seen.has(metadata.parentId)) return 1;

  seen.add(metadata.parentId);
  const parentFile = findCodexSessionFileById(metadata.parentId);
  return parentFile ? 1 + forkDepthForFile(parentFile, seen) : 1;
}

function writeForkedCodexSqliteMetadata(
  sourceSessionId: string,
  forkId: string,
  forkPath: string,
  forkTitle: string,
  now: Date,
) {
  const dbPath = codexStateDbPath();
  if (!dbPath) return;

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    const source = db
      .query(`
        SELECT source, model_provider, cwd, sandbox_policy, approval_mode, cli_version,
               first_user_message, agent_nickname, agent_role, memory_mode, model,
               reasoning_effort, agent_path, thread_source, preview, git_sha,
               git_branch, git_origin_url
        FROM threads
        WHERE id = ?
      `)
      .get(sourceSessionId) as Record<string, unknown> | null;
    if (!source) return;

    const seconds = Math.floor(now.getTime() / 1000);
    db.query(`
      INSERT OR REPLACE INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd,
        title, sandbox_policy, approval_mode, tokens_used, has_user_event,
        archived, archived_at, git_sha, git_branch, git_origin_url, cli_version,
        first_user_message, agent_nickname, agent_role, memory_mode, model,
        reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source,
        preview
      )
      VALUES (
        $id, $rollout_path, $created_at, $updated_at, $source, $model_provider, $cwd,
        $title, $sandbox_policy, $approval_mode, 0, 1, 0, NULL, $git_sha,
        $git_branch, $git_origin_url, $cli_version, $first_user_message,
        $agent_nickname, $agent_role, $memory_mode, $model, $reasoning_effort,
        $agent_path, $created_at_ms, $updated_at_ms, $thread_source, $preview
      )
    `).run({
      $id: forkId,
      $rollout_path: forkPath,
      $created_at: seconds,
      $updated_at: seconds,
      $source: stringValue(source.source) ?? "workshop",
      $model_provider: stringValue(source.model_provider) ?? "",
      $cwd: stringValue(source.cwd) ?? os.homedir(),
      $title: forkTitle,
      $sandbox_policy: stringValue(source.sandbox_policy) ?? "",
      $approval_mode: stringValue(source.approval_mode) ?? "",
      $git_sha: stringValue(source.git_sha),
      $git_branch: stringValue(source.git_branch),
      $git_origin_url: stringValue(source.git_origin_url),
      $cli_version: stringValue(source.cli_version) ?? "",
      $first_user_message: forkTitle,
      $agent_nickname: stringValue(source.agent_nickname),
      $agent_role: stringValue(source.agent_role),
      $memory_mode: stringValue(source.memory_mode) ?? "enabled",
      $model: stringValue(source.model),
      $reasoning_effort: stringValue(source.reasoning_effort),
      $agent_path: stringValue(source.agent_path),
      $created_at_ms: now.getTime(),
      $updated_at_ms: now.getTime(),
      $thread_source: stringValue(source.thread_source) ?? "user",
      $preview: forkTitle,
    });
  } catch {
    return;
  } finally {
    db?.close();
  }
}

function readForkedCodexMetadata(filePath: string): { isFork: boolean; title: string | null; parentId: string | null } | null {
  const line = firstSessionMetaLine(filePath);
  if (!line) return null;

  const event = parseLine(line);
  const payload = objectValue(event?.payload);
  if (!payload) return null;

  const title = stringValue(payload.workshop_title) ?? stringValue(payload.title);
  const parentId = stringValue(payload.forked_from_id);
  return {
    isFork: stringValue(payload.originator) === "workshop_codex_fork" || !!parentId,
    title,
    parentId,
  };
}

function updateForkedCodexSessionLine(filePath: string, sessionId: string, forkTitle: string) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let changed = false;
  const updated = lines.map((line) => {
    if (changed || !line.trim() || !isSessionMetaLine(line)) return line;
    const event = parseLine(line);
    const payload = objectValue(event?.payload);
    if (!payload || stringValue(payload.id) !== sessionId) return line;
    changed = true;
    event!.payload = {
      ...payload,
      title: forkTitle,
      workshop_title: forkTitle,
      originator: stringValue(payload.originator) ?? "workshop_codex_fork",
      workshop_visible_after: stringValue(payload.workshop_visible_after) ?? stringValue(payload.timestamp),
    };
    return JSON.stringify(event);
  });
  if (changed) fs.writeFileSync(filePath, updated.join("\n"));
}

function updateCodexSqliteForkTitle(sessionId: string, forkTitle: string) {
  const dbPath = codexStateDbPath();
  if (!dbPath) return;

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.query(`
      UPDATE threads
      SET title = ?, first_user_message = ?, preview = ?
      WHERE id = ?
    `).run(forkTitle, forkTitle, forkTitle, sessionId);
  } catch {
    return;
  } finally {
    db?.close();
  }
}

function firstSessionMetaLine(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const chunks: string[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    let totalBytes = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      totalBytes += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead).toString("utf8"));
      const text = chunks.join("");
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        const line = text.slice(0, newline).replace(/\r$/, "");
        return isSessionMetaLine(line) ? line : null;
      }
    } while (totalBytes < 1024 * 1024);
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  return null;
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

interface CodexSessionMetadata {
  title: string | null;
  preview: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  threadSource: string | null;
}

function readCodexSessionMetadata(): Map<string, CodexSessionMetadata> {
  const metadata = readCodexSqliteMetadata();
  for (const [id, threadName] of readCodexSessionIndex()) {
    const existing = metadata.get(id);
    metadata.set(id, {
      title: codexDisplayText(threadName) ?? existing?.title ?? null,
      preview: existing?.preview ?? null,
      cwd: existing?.cwd ?? null,
      createdAt: existing?.createdAt ?? null,
      updatedAt: existing?.updatedAt ?? null,
      threadSource: existing?.threadSource ?? null,
    });
  }
  return metadata;
}

function readCodexSqliteMetadata(): Map<string, CodexSessionMetadata> {
  const dbPath = codexStateDbPath();
  const metadata = new Map<string, CodexSessionMetadata>();
  if (!dbPath) return metadata;

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.query(`
      SELECT id, title, preview, first_user_message, cwd, created_at_ms, updated_at_ms, created_at, updated_at, thread_source
      FROM threads
      WHERE archived = 0
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = stringValue(row.id);
      if (!id) continue;
      const title = codexDisplayText(stringValue(row.title));
      const preview = codexDisplayText(stringValue(row.preview)) ?? codexDisplayText(stringValue(row.first_user_message));
      metadata.set(id, {
        title,
        preview,
        cwd: stringValue(row.cwd),
        createdAt: isoFromEpoch(row.created_at_ms, row.created_at),
        updatedAt: isoFromEpoch(row.updated_at_ms, row.updated_at),
        threadSource: stringValue(row.thread_source),
      });
    }
  } catch {
    return metadata;
  } finally {
    db?.close();
  }
  return metadata;
}

function readCodexSessionIndex(): Map<string, string> {
  const indexPath = path.join(codexRoot(), "session_index.jsonl");
  const entries = new Map<string, string>();
  if (!fs.existsSync(indexPath)) return entries;

  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const entry = parseLine(line);
    const id = stringValue(entry?.id);
    const threadName = stringValue(entry?.thread_name);
    if (id && threadName) entries.set(id, threadName);
  }
  return entries;
}

function codexStateDbPath(): string | null {
  const root = codexRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  return entries
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .map((name) => path.join(root, name))
    .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a))[0] ?? null;
}

function codexRoot(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function isoFromEpoch(epochMs: unknown, epochSeconds: unknown): string | null {
  const ms = numberValue(epochMs);
  if (ms) return new Date(ms).toISOString();
  const seconds = numberValue(epochSeconds);
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function readCodexSessionSummaryFile(
  filePath: string,
  metadata = readCodexSessionMetadata(),
): ClaudeSessionSummary | null {
  if (!fs.existsSync(filePath)) return null;
  let id = "";
  let cwd = "";
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastPrompt: string | null = null;
  let fallbackTitle: string | null = null;
  let visibleAfterMs: number | null = null;
  let threadSource: string | null = null;
  let currentSessionMetaRead = false;
  let messageCount = 0;
  let assistantOpen = false;
  let skipNextMaintenanceAssistant = false;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const event = parseLine(line);
    if (!event) continue;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;

    if (event.type === "session_meta") {
      if (!currentSessionMetaRead) {
        const payload = objectValue(event.payload);
        if (typeof payload?.id === "string") id = payload.id;
        if (typeof payload?.cwd === "string") cwd = payload.cwd;
        if (typeof payload?.thread_source === "string") threadSource = payload.thread_source;
        fallbackTitle = stringValue(payload?.workshop_title) ?? stringValue(payload?.title);
        visibleAfterMs = forkVisibleAfterMs(payload, timestamp);
        if (timestamp) {
          createdAt ??= timestamp;
          updatedAt = timestamp;
        }
        currentSessionMetaRead = true;
      }
      continue;
    }

    if (isBeforeVisibleForkWindow(timestamp, visibleAfterMs)) continue;
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }

    if (event.type !== "response_item") continue;
    const payload = objectValue(event.payload);
    if (!payload) continue;

    if (payload.type === "message") {
      const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
      if (!role) continue;
      const content = stripWorkshopContext(contentText(payload.content));
      if (!content.trim()) continue;
      if (role === "user") {
        if (isCodexHiddenUserMessage(content)) {
          skipNextMaintenanceAssistant = isCodexForkCompactUserMessage(content);
          continue;
        }
        assistantOpen = false;
        lastPrompt = content;
        messageCount += 1;
        continue;
      }
      if (skipNextMaintenanceAssistant) {
        skipNextMaintenanceAssistant = false;
        continue;
      }
      if (!assistantOpen) {
        messageCount += 1;
        assistantOpen = true;
      }
      continue;
    }

    if (payload.type === "function_call" && !assistantOpen) {
      messageCount += 1;
      assistantOpen = true;
    }
  }

  const indexed = metadata.get(id);
  if (!id || !cwd || threadSource === "subagent" || indexed?.threadSource === "subagent") return null;
  const forkMetadata = readForkedCodexMetadata(filePath);
  const title = codexSessionTitle(filePath, indexed?.title, fallbackTitle, forkMetadata);
  repairForkTitleIfNeeded(filePath, id, indexed?.title, title, fallbackTitle, forkMetadata);
  return {
    id,
    path: filePath,
    cwd,
    title,
    is_fork: forkMetadata?.isFork ?? false,
    forked_from_id: forkMetadata?.parentId ?? null,
    fork_depth: forkMetadata?.isFork ? parseForkedTitle(title ?? "").depth || 1 : 0,
    created_at: createdAt ?? indexed?.createdAt ?? null,
    updated_at: updatedAt ?? indexed?.updatedAt ?? null,
    message_count: messageCount,
    loaded_message_count: 0,
    messages_truncated: messageCount > 0,
    last_prompt: lastPrompt,
    preview: previewText(lastPrompt || indexed?.preview || null),
  };
}

function readCodexSessionFile(
  filePath: string,
  metadata = readCodexSessionMetadata(),
  options: CodexSessionReadOptions = {},
): ClaudeSessionDetail | null {
  if (!fs.existsSync(filePath)) return null;
  const messages: ClaudeChatMessage[] = [];
  const toolBlocks = new Map<string, Extract<ClaudeChatMessageBlock, { type: "tool" }>>();
  let id = "";
  let cwd = "";
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastPrompt: string | null = null;
  let fallbackTitle: string | null = null;
  let visibleAfterMs: number | null = null;
  let threadSource: string | null = null;
  let currentSessionMetaRead = false;
  let assistantBlocks: ClaudeChatMessageBlock[] = [];
  let assistantTimestamp: string | null = null;
  let skipNextMaintenanceAssistant = false;
  let messageCount = 0;
  let lastUserMessage: ClaudeChatMessage | null = null;
  let lastVisibleMessage: ClaudeChatMessage | null = null;
  const messageLimit = options.messageLimit ?? DEFAULT_DETAIL_MESSAGE_LIMIT;

  const pushMessage = (message: ClaudeChatMessage) => {
    messageCount += 1;
    lastVisibleMessage = message;
    if (message.role === "user") lastUserMessage = message;
    if (messageLimit <= 0) return;
    messages.push(message);
    while (messages.length > messageLimit) messages.shift();
  };

  const flushAssistant = () => {
    if (!assistantBlocks.length) return;
    const content = assistantBlocksText(assistantBlocks);
    if (content.trim()) {
      pushMessage({
        id: `${id || path.basename(filePath, ".jsonl")}-${messageCount}`,
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

    if (event.type === "session_meta") {
      if (!currentSessionMetaRead) {
        const payload = objectValue(event.payload);
        if (typeof payload?.id === "string") id = payload.id;
        if (typeof payload?.cwd === "string") cwd = payload.cwd;
        if (typeof payload?.thread_source === "string") threadSource = payload.thread_source;
        fallbackTitle = stringValue(payload?.workshop_title) ?? stringValue(payload?.title);
        visibleAfterMs = forkVisibleAfterMs(payload, timestamp);
        if (timestamp) {
          createdAt ??= timestamp;
          updatedAt = timestamp;
        }
        currentSessionMetaRead = true;
      }
      continue;
    }

    if (isBeforeVisibleForkWindow(timestamp, visibleAfterMs)) continue;
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
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
        if (!content.trim()) continue;
        if (isCodexHiddenUserMessage(content)) {
          skipNextMaintenanceAssistant = isCodexForkCompactUserMessage(content);
          continue;
        }
        lastPrompt = content;
        pushMessage({
          id: `${id || path.basename(filePath, ".jsonl")}-${messageCount}`,
          role,
          content,
          blocks: [{ type: "text", text: content }],
          timestamp,
        });
        continue;
      }

      const content = stripWorkshopContext(rawContent);
      if (!content.trim()) continue;
      if (skipNextMaintenanceAssistant) {
        skipNextMaintenanceAssistant = false;
        continue;
      }
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

  const indexed = metadata.get(id);
  if (!id || !cwd || threadSource === "subagent" || indexed?.threadSource === "subagent") return null;
  const forkMetadata = readForkedCodexMetadata(filePath);
  const title = codexSessionTitle(filePath, indexed?.title, fallbackTitle, forkMetadata);
  repairForkTitleIfNeeded(filePath, id, indexed?.title, title, fallbackTitle, forkMetadata);
  const previewSource =
    lastPrompt ||
    (lastUserMessage as ClaudeChatMessage | null)?.content ||
    (lastVisibleMessage as ClaudeChatMessage | null)?.content ||
    indexed?.preview ||
    null;
  return {
    id,
    path: filePath,
    cwd,
    title,
    is_fork: forkMetadata?.isFork ?? false,
    forked_from_id: forkMetadata?.parentId ?? null,
    fork_depth: forkMetadata?.isFork ? parseForkedTitle(title ?? "").depth || 1 : 0,
    created_at: createdAt ?? indexed?.createdAt ?? null,
    updated_at: updatedAt ?? indexed?.updatedAt ?? null,
    message_count: messageCount,
    loaded_message_count: messages.length,
    messages_truncated: messageCount > messages.length,
    last_prompt: lastPrompt,
    preview: previewText(previewSource),
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

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function isCodexHiddenUserMessage(content: string): boolean {
  return (
    content.startsWith("# AGENTS.md instructions") ||
    content.startsWith("<subagent_notification>") ||
    content.startsWith("<turn_aborted>") ||
    content.startsWith("<goal_") ||
    isCodexForkCompactUserMessage(content)
  );
}

function isCodexForkCompactUserMessage(content: string): boolean {
  return content.startsWith("<workshop_internal_compact_fork>");
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

function codexSessionTitle(
  filePath: string,
  indexedTitle: string | null | undefined,
  fallbackTitle: string | null,
  forkMetadata = readForkedCodexMetadata(filePath),
): string | null {
  if (forkMetadata?.isFork) {
    return storedForkedCodexTitle(fallbackTitle ?? indexedTitle ?? null, filePath);
  }
  return indexedTitle ?? fallbackTitle ?? null;
}

function repairForkTitleIfNeeded(
  filePath: string,
  sessionId: string,
  indexedTitle: string | null | undefined,
  title: string | null,
  fallbackTitle: string | null,
  forkMetadata = readForkedCodexMetadata(filePath),
) {
  if (!title || !forkMetadata?.isFork) return;
  if (indexedTitle === title && fallbackTitle === title) return;
  updateForkedCodexSessionLine(filePath, sessionId, title);
  updateCodexSqliteForkTitle(sessionId, title);
}

function forkVisibleAfterMs(payload: Record<string, unknown> | null, eventTimestamp: string | null): number | null {
  if (!payload) return null;
  const isFork = stringValue(payload.originator) === "workshop_codex_fork" || !!stringValue(payload.forked_from_id);
  if (!isFork) return null;
  return timestampMs(stringValue(payload.workshop_visible_after) ?? stringValue(payload.timestamp) ?? eventTimestamp);
}

function isBeforeVisibleForkWindow(timestamp: string | null, visibleAfterMs: number | null): boolean {
  if (visibleAfterMs == null) return false;
  const ms = timestampMs(timestamp);
  return ms != null && ms < visibleAfterMs;
}

function timestampMs(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function codexDisplayText(value: string | null): string | null {
  return previewText(value ? stripWorkshopContext(value) : null);
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

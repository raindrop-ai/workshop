import { randomUUID } from "crypto";

/**
 * In-memory store mapping short-lived UUID tokens to a request-scoped Raindrop
 * Query API key. The MCP child process spawned by Claude/Codex receives the
 * token (never the raw key) so we keep the key off the child's argv and out of
 * any log line that captures the request body.
 *
 * Entries are evicted on request completion (via `release`) and additionally
 * pruned by an *idle* TTL + size cap so a daemon crash mid-chat can't leak a
 * key for the rest of the process lifetime. The TTL is sliding: every
 * successful `resolve()` extends `expiresAt` by `ttlMs` forward, so a token
 * actively used by a long-running chat stays valid as long as the chat keeps
 * making cloud MCP calls. After `ttlMs` of inactivity it expires.
 */
export interface TransientQueryApiKeyStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  key: string;
  expiresAt: number;
}

export const DEFAULT_TRANSIENT_KEY_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TRANSIENT_KEY_MAX_ENTRIES = 128;

export class TransientQueryApiKeyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TransientQueryApiKeyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TRANSIENT_KEY_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_TRANSIENT_KEY_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Issue a new token mapping to `key`. Returns null if `key` is empty. */
  issue(key: string): string | null {
    const trimmed = key.trim();
    if (!trimmed) return null;
    this.prune();
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest entry (Map iteration order is insertion order).
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const token = randomUUID();
    this.entries.set(token, { key: trimmed, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /**
   * Resolve a token to its key, or null if missing/expired. Slides the entry's
   * TTL forward on a successful resolve so an actively-used token doesn't
   * expire mid-chat. The TTL therefore measures *idle* time, not absolute age.
   */
  resolve(token: string): string | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(token);
      return null;
    }
    entry.expiresAt = now + this.ttlMs;
    // Reinsert so the Map iteration order tracks recency for the size-cap
    // eviction path (oldest = least-recently-used).
    this.entries.delete(token);
    this.entries.set(token, entry);
    return entry.key;
  }

  /** Remove a token unconditionally. Safe to call with an unknown token. */
  release(token: string | null | undefined): void {
    if (!token) return;
    this.entries.delete(token);
  }

  /** Drop expired entries. Called opportunistically. */
  prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

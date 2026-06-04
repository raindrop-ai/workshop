import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { VERSION } from "../version";
import { HOSTED_MCP_URL } from "./constants";
import { acquireOAuthAccessToken } from "./oauth";

export interface FetchWriteKeyOptions {
  /** When provided, used directly as a Bearer token (org API key) — skips OAuth. */
  apiKey?: string;
  /** Reuse a bearer token already acquired this run — skips OAuth + the browser. */
  accessToken?: string;
  /** Override the hosted MCP URL (tests / staging). */
  serverUrl?: string;
}

/**
 * Bound the connect + `get_write_key` round-trip. The MCP SDK already applies a
 * 60s default per request, but we tighten it so a slow/unreachable hosted MCP
 * surfaces a clear error instead of stalling a login or `cloud setup` for a
 * full minute (especially under the non-interactive onboarding one-liner).
 */
const WRITE_KEY_TIMEOUT_MS = 30 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull the write key out of the get_write_key tool's JSON text payload. */
export function extractWriteKey(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const data = parsed.data;
  if (isRecord(data) && typeof data.write_key === "string" && data.write_key) {
    return data.write_key;
  }
  if (typeof parsed.write_key === "string" && parsed.write_key) {
    return parsed.write_key;
  }
  return undefined;
}

/** Pull a server-provided error string out of a tool payload, if any. */
export function extractToolError(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error) {
    return parsed.error;
  }
  return undefined;
}

/**
 * Authenticate to the hosted Raindrop MCP and call `get_write_key`. Prefers an
 * already-acquired access token, then an org API key, otherwise drives the
 * OAuth browser flow. The returned value is a secret and must never be logged.
 */
export async function fetchWriteKey(opts: FetchWriteKeyOptions = {}): Promise<string> {
  const serverUrl = opts.serverUrl ?? HOSTED_MCP_URL;
  const token =
    opts.accessToken ?? opts.apiKey ?? (await acquireOAuthAccessToken(serverUrl));

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "raindrop-cli", version: VERSION });

  // Abort the underlying HTTP request once the deadline passes so a stalled
  // connection can't hang the CLI past WRITE_KEY_TIMEOUT_MS.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WRITE_KEY_TIMEOUT_MS);
  try {
    await client.connect(transport, { timeout: WRITE_KEY_TIMEOUT_MS, signal: ac.signal });
    const result = await client.callTool(
      { name: "get_write_key", arguments: {} },
      undefined,
      { timeout: WRITE_KEY_TIMEOUT_MS, signal: ac.signal },
    );
    const content = result.content;
    const texts: string[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
          const key = extractWriteKey(item.text);
          if (key) return key;
          texts.push(item.text);
        }
      }
    }
    // Surface the server's own error (e.g. "Write key not found") rather than a
    // generic message when the tool reported a problem instead of a key.
    const serverError = texts.map(extractToolError).find((message) => message);
    if (serverError) {
      throw new Error(`Raindrop could not provide a write key: ${serverError}`);
    }
    throw new Error("The get_write_key tool did not return a write key.");
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

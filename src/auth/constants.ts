import os from "node:os";
import path from "node:path";

/**
 * Hosted Raindrop MCP endpoint (Streamable HTTP, OAuth 2.1 + API-key auth).
 * Overridable via RAINDROP_MCP_URL for staging; `raindrop login --server-url`
 * takes precedence over the env var.
 */
export const HOSTED_MCP_URL =
  process.env.RAINDROP_MCP_URL?.trim() || "https://mcp.raindrop.ai/mcp";

/** Name the hosted (cloud) MCP server is registered as inside each agent config. */
export const CLOUD_MCP_SERVER_NAME = "raindrop";

/** Environment variable the SDK reads the write key from. */
export const WRITE_KEY_ENV_VAR = "RAINDROP_WRITE_KEY";

/** Environment variable / flag used for non-interactive (CI) auth. */
export const API_KEY_ENV_VAR = "RAINDROP_API_KEY";

/** Cloud app origin used for verification permalinks. */
export const APP_ORIGIN = "https://app.raindrop.ai";

/** OAuth scope requested for the write-key fetch. */
export const OAUTH_SCOPE = "read:all";

/**
 * Where the CLI persists OAuth client registration + tokens (user-only, 0600).
 * Overridable via RAINDROP_AUTH_STORE so tests can point the whole auth flow
 * (probe + provider reads/writes) at a throwaway file instead of $HOME.
 */
export function authStorePath(): string {
  return process.env.RAINDROP_AUTH_STORE?.trim() || path.join(os.homedir(), ".raindrop", "setup-auth.json");
}

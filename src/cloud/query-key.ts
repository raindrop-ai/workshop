/**
 * Defensive validation for the Raindrop Query API key as it crosses untrusted
 * boundaries (HTTP request body, request header, MCP tool args). Real keys are
 * opaque to the daemon, so the check is conservative: print-only ASCII without
 * whitespace, and a length envelope generous enough for any current or future
 * key format.
 */
const MIN_KEY_LEN = 16;
const MAX_KEY_LEN = 512;
const ALLOWED_KEY_RE = /^[\x21-\x7e]+$/;

export function isValidQueryApiKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < MIN_KEY_LEN || value.length > MAX_KEY_LEN) return false;
  return ALLOWED_KEY_RE.test(value);
}

export function normalizeQueryApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isValidQueryApiKey(trimmed) ? trimmed : null;
}

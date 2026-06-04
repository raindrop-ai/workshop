import type { RequestHandler } from "express";

/**
 * Origin/Referer allowlist for mutating Workshop daemon endpoints.
 *
 * The Workshop daemon binds loopback by default, but the same browser session
 * may have other tabs open. Non-browser callers (MCP child, curl) send no
 * Origin header and are allowed through unchanged so existing tooling keeps
 * working; browser callers must come from a loopback origin (or one explicitly
 * configured via RAINDROP_WORKSHOP_ALLOWED_ORIGINS).
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function parseHost(value: string): { host: string; port: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { host: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

export function isLoopbackOrigin(value: string | undefined | null): boolean {
  if (!value) return false;
  const parsed = parseHost(value);
  if (!parsed) return false;
  return LOOPBACK_HOSTS.has(parsed.host);
}

export function parseAllowedOriginsEnv(value: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const raw of value.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Normalize trailing slash / case so set lookup is stable.
    const normalized = trimmed.replace(/\/+$/, "").toLowerCase();
    out.add(normalized);
  }
  return out;
}

export interface LocalOriginGuardOptions {
  extraAllowedOrigins?: Iterable<string>;
}

export function createLocalOriginGuard(options: LocalOriginGuardOptions = {}): RequestHandler {
  const extra = new Set<string>();
  for (const value of options.extraAllowedOrigins ?? []) {
    extra.add(value.replace(/\/+$/, "").toLowerCase());
  }

  return (req, res, next) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const referer = typeof req.headers.referer === "string" ? req.headers.referer : null;

    // No browser-supplied origin: curl, fetch from MCP child, etc. Allow.
    if (!origin && !referer) return next();

    const candidate = origin ?? referer ?? "";
    if (isLoopbackOrigin(candidate)) return next();

    const normalized = candidate.replace(/\/+$/, "").toLowerCase();
    if (extra.has(normalized)) return next();
    // Allow when only the origin portion (scheme://host[:port]) matches an
    // entry; Referer headers carry full paths.
    const parsed = parseHost(candidate);
    if (parsed) {
      const originOnly = `${candidate.startsWith("https://") ? "https" : "http"}://${parsed.host}${parsed.port ? ":" + parsed.port : ""}`;
      if (extra.has(originOnly.toLowerCase())) return next();
    }

    res.status(403).json({ error: "origin not allowed" });
  };
}

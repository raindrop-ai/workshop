import { isIP } from "net";

export const WORKSHOP_BIND_HOST = "127.0.0.1";

export function isLoopbackRemoteAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;

  const ipv4 = address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
  if (isIP(ipv4) !== 4) return false;

  return ipv4.split(".")[0] === "127";
}

/**
 * True for loopback plus RFC1918 / link-local / IPv6 ULA source addresses —
 * i.e. the ranges a container or VM on the same host reaches Workshop from
 * (e.g. the Docker bridge gateway `172.17.0.1` on Linux or `192.168.65.x` on
 * Docker Desktop). Only consulted when the operator has opted a listener open
 * to the local network via RAINDROP_WORKSHOP_ALLOWED_HOSTS; it still excludes
 * public addresses so a broadly-bound daemon can't be reached from the WAN.
 */
export function isPrivateRemoteAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  if (isLoopbackRemoteAddress(address)) return true;

  const ipv4 = address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
  if (isIP(ipv4) === 4) {
    const [a, b] = ipv4.split(".").map((part) => Number(part));
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    return false;
  }

  return false;
}

/**
 * Parse RAINDROP_WORKSHOP_ALLOWED_HOSTS into a set of bare, lowercased
 * hostnames accepted in the Host header (and, when present, the Origin
 * hostname). Entries may include a port (`host.docker.internal:5899`) or even
 * be pasted as a full URL (`http://host.docker.internal:5899/`); both are
 * reduced to the hostname. Entries that don't resolve to a hostname are
 * dropped so a typo can't leave the allowlist non-empty (which would flip on
 * private-network access) while blocking the intended host.
 */
export function parseAllowedHostsEnv(value: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const raw of value.split(",")) {
    let trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    // Tolerate URL-shaped entries (a common copy/paste from RAINDROP_LOCAL_DEBUGGER).
    if (trimmed.includes("://")) {
      try {
        trimmed = new URL(raw.trim()).hostname.toLowerCase();
      } catch {
        continue;
      }
    }
    const name = hostnameOnly(trimmed);
    if (name) out.add(name);
  }
  return out;
}

/**
 * Extract the bare hostname from a Host header value or allowlist entry,
 * dropping any port. Handles bracketed (`[::1]:5899`) and bare (`::1`) IPv6.
 */
export function hostnameOnly(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  // A bare (unbracketed) IPv6 address contains multiple colons and no port —
  // don't treat the last segment as a port and truncate it.
  if (isIP(host) === 6) return host;
  return host.split(":")[0];
}

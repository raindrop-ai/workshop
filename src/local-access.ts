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

/**
 * Cheap "is anything listening on this TCP port?" probe.
 *
 * Tries to bind a fresh server to :port exactly like the Workshop server does.
 * If the bind succeeds the port is free (we close it immediately). Any listen
 * error — EADDRINUSE or otherwise — means the port is taken.
 */
import net from "net";
import { WORKSHOP_BIND_HOST } from "./local-access";

const MAX_PORT = 65535;

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once("error", () => settle(false));
    server.once("listening", () => {
      server.close(() => settle(true));
    });
    try {
      server.listen(port, WORKSHOP_BIND_HOST);
    } catch {
      settle(false);
    }
  });
}

export async function findFreePort(startPort: number): Promise<number> {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > MAX_PORT) {
    throw new Error(`invalid port: ${startPort}`);
  }

  for (let port = startPort; port <= MAX_PORT; port++) {
    if (await isPortFree(port)) return port;
  }

  throw new Error(`no free port available at or above :${startPort}`);
}

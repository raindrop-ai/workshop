import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import net from "node:net";
import { createServer } from "../src/server";

let servers: Server[] = [];

async function startWorkshop() {
  const { server } = await createServer(0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  return { server, port: address.port };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function websocketHandshakeStatus(port: number, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("websocket connection timed out"));
    }, 2000);
    socket.once("connect", () => {
      socket.write([
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Origin: ${origin}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const match = response.match(/^HTTP\/1\.1\s+(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve(Number(match[1]));
    });
    socket.once("error", reject);
  });
}

afterEach(async () => {
  const openServers = servers;
  servers = [];
  await Promise.all(openServers.map(closeServer));
});

describe("workshop websocket origin checks", () => {
  test("rejects cross-origin browser websocket upgrades", async () => {
    const { port } = await startWorkshop();

    const status = await websocketHandshakeStatus(port, "https://evil.example");
    expect(status).toBe(403);
  });

  test("allows same-origin localhost websocket upgrades", async () => {
    const { port } = await startWorkshop();

    const status = await websocketHandshakeStatus(port, `http://127.0.0.1:${port}`);
    expect(status).toBe(101);
  });
});

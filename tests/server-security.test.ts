import { afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "net";
import { WORKSHOP_BIND_HOST, isLoopbackRemoteAddress } from "../src/local-access";
import { createServer } from "../src/server";

const servers: Array<Awaited<ReturnType<typeof createServer>>["server"]> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

describe("local control-plane boundary", () => {
  test("recognizes loopback peer addresses", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.10.20.30")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);

    expect(isLoopbackRemoteAddress("192.168.1.42")).toBe(false);
    expect(isLoopbackRemoteAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackRemoteAddress("::ffff:192.168.1.42")).toBe(false);
    expect(isLoopbackRemoteAddress("::")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });

  test("binds the daemon host to loopback", async () => {
    const { server } = await createServer(0);
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, WORKSHOP_BIND_HOST, () => resolve());
    });

    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe(WORKSHOP_BIND_HOST);
  });
});

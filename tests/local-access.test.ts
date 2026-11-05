import { describe, expect, test } from "bun:test";

import {
  hostnameOnly,
  isAllowedLocalHostname,
  isLoopbackRemoteAddress,
  parseAllowedHostsEnv,
} from "../src/local-access";

describe("isAllowedLocalHostname", () => {
  test("accepts the loopback names a client can send", () => {
    for (const host of ["localhost", "LocalHost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]) {
      expect(isAllowedLocalHostname(host)).toBe(true);
    }
  });

  test("accepts IPv6 loopback in the bracketed forms a Host header and an Origin carry", () => {
    // A Host header keeps the port; URL.hostname keeps the brackets and drops it.
    expect(isAllowedLocalHostname("[::1]:5899")).toBe(true);
    expect(isAllowedLocalHostname(new URL("http://[::1]:5900/").hostname)).toBe(true);
  });

  test("accepts every loopback address the socket-layer check accepts", () => {
    // The two guards run on the same request, so a divergence is a closed door.
    for (const address of ["127.0.0.1", "127.0.0.2", "127.1.2.3", "::1"]) {
      expect(isLoopbackRemoteAddress(address)).toBe(true);
      expect(isAllowedLocalHostname(address)).toBe(true);
    }
  });

  test("rejects non-loopback hosts when nothing is allowlisted", () => {
    for (const host of [
      "evil.com",
      "host.docker.internal",
      "192.168.1.50",
      "10.0.0.5",
      "172.17.0.1",
      "169.254.169.254",
      "8.8.8.8",
    ]) {
      expect(isAllowedLocalHostname(host)).toBe(false);
    }
  });

  test("rejects names that merely contain a loopback label", () => {
    for (const host of ["localhost.evil.com", "notlocalhost", "127.0.0.1.evil.com"]) {
      expect(isAllowedLocalHostname(host)).toBe(false);
    }
  });

  test("accepts an allowlisted host, with or without a port, and nothing else", () => {
    const allowed = parseAllowedHostsEnv("host.docker.internal");
    expect(isAllowedLocalHostname("host.docker.internal", allowed)).toBe(true);
    expect(isAllowedLocalHostname("host.docker.internal:5899", allowed)).toBe(true);
    expect(isAllowedLocalHostname("HOST.DOCKER.INTERNAL:5899", allowed)).toBe(true);
    expect(isAllowedLocalHostname("evil.com", allowed)).toBe(false);
  });
});

describe("parseAllowedHostsEnv", () => {
  test("reduces ports and URL-shaped entries to bare hostnames", () => {
    const allowed = parseAllowedHostsEnv(
      "host.docker.internal:5899, http://gateway.internal:5899/v1/ ,  ",
    );
    expect(allowed.has("host.docker.internal")).toBe(true);
    expect(allowed.has("gateway.internal")).toBe(true);
    expect(allowed.size).toBe(2);
  });

  test("is empty for an unset value, so the daemon stays loopback-only by default", () => {
    expect(parseAllowedHostsEnv(undefined).size).toBe(0);
    expect(parseAllowedHostsEnv("").size).toBe(0);
  });
});

describe("hostnameOnly", () => {
  test("drops the port without truncating a bare IPv6 address", () => {
    expect(hostnameOnly("localhost:5899")).toBe("localhost");
    expect(hostnameOnly("[::1]:5899")).toBe("::1");
    expect(hostnameOnly("::1")).toBe("::1");
    expect(hostnameOnly("0:0:0:0:0:0:0:1")).toBe("0:0:0:0:0:0:0:1");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import request from "supertest";
import { createServer } from "../src/server";

const { app, server } = await createServer(0);

afterAll(() => {
  server.close();
});

describe("security headers", () => {
  test("prevents hostile pages from framing the Workshop UI", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });
});

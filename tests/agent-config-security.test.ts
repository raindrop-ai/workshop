import { describe, expect, test } from "bun:test";
import { sanitizeLegacyAgentsConfig } from "../src/agents-config";

describe("legacy agent settings config", () => {
  test("drops command-capable replay fields from HTTP-managed config", () => {
    expect(
      sanitizeLegacyAgentsConfig({
        checkout: {
          url: " http://127.0.0.1:61020/replay ",
          cwd: "/tmp/project",
          command: "touch /tmp/workshop-owned",
          configPath: "/tmp/project/.raindrop/agents.yaml",
          lastSeenPort: 61020,
          input: { ticket: "properties.ticket", count: 4 },
          prefillFromTrace: { user: "properties.user" },
          contextFromTrace: { repo: "properties.repo" },
          models: ["claude", 42, "gpt"],
        },
      }),
    ).toEqual({
      checkout: {
        url: "http://127.0.0.1:61020/replay",
        input: { ticket: "properties.ticket" },
        prefillFromTrace: { user: "properties.user" },
        contextFromTrace: { repo: "properties.repo" },
        models: ["claude", "gpt"],
      },
    });
  });

  test("drops command-only entries entirely", () => {
    expect(
      sanitizeLegacyAgentsConfig({
        evil: {
          cwd: "/tmp/project",
          command: "touch /tmp/workshop-owned",
        },
      }),
    ).toEqual({});
  });
});

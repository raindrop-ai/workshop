import { expect, test } from "bun:test";
import { defaultAgentLoadout } from "../src/agent-chat";
import { AGENT_PROVIDER_IDS, parseAgentProvider, providerAnnotationSource, providerLabel } from "../src/agent-provider";

test("OpenCode is part of the canonical provider registry", () => {
  expect(AGENT_PROVIDER_IDS).toContain("opencode");
  expect(parseAgentProvider("opencode")).toBe("opencode");
  expect(providerLabel("opencode")).toBe("OpenCode");
  expect(providerAnnotationSource("opencode")).toBe("opencode");
});

test("OpenCode gets the non-Claude default slash commands", () => {
  expect(defaultAgentLoadout("opencode").slash_commands).toEqual(["/clear", "/trace"]);
});

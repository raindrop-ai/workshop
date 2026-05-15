import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyInstallPlan } from "../src/install/apply";
import { getSupportedInstallAgents } from "../src/install/detect";
import { loadInstallRegistry } from "../src/install/registry";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode setup support is detected for skills and MCP", () => {
  const agents = getSupportedInstallAgents({ scope: "local" });
  const opencode = agents.find((agent) => agent.agent === "opencode");

  expect(opencode).toEqual(expect.objectContaining({
    agent: "opencode",
    supportsSkills: true,
    supportsMcp: true,
  }));
});

test("local OpenCode setup writes opencode.json with the Raindrop MCP server", async () => {
  const root = makeTempDir("workshop-opencode-install-");
  const cwd = path.join(root, "project");
  const bundleRoot = path.join(root, "bundle");
  const registryFile = path.join(root, "registry.json");
  const binPath = path.join(root, "bin", "raindrop");
  fs.mkdirSync(cwd, { recursive: true });

  const result = await applyInstallPlan({
    items: [{
      agent: "opencode",
      scope: "local",
      cwd,
      label: "OpenCode",
    }],
  }, {
    binPath,
    bundleRoot,
    registryFile,
  });

  expect(result.items).toHaveLength(1);
  expect(result.items[0].agent).toBe("opencode");
  expect(result.items[0].skillsFailed).toHaveLength(0);
  expect(result.items[0].mcp.success).toBe(true);
  expect(result.items[0].mcp.path).toBe(path.join(cwd, "opencode.json"));

  const config = JSON.parse(fs.readFileSync(path.join(cwd, "opencode.json"), "utf8"));
  expect(config.mcp.raindrop).toEqual({
    type: "local",
    command: [binPath, "workshop", "mcp"],
    enabled: true,
    environment: {},
  });

  const registry = loadInstallRegistry(registryFile);
  expect(registry.installs).toEqual([
    expect.objectContaining({
      id: `local:opencode:${cwd}`,
      agent: "opencode",
      scope: "local",
      cwd,
      installer: "agent-install",
    }),
  ]);
});

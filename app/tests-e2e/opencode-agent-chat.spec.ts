import { expect, test } from "./fixtures";
import { requireBinaryOrThrow } from "./helpers";

test.setTimeout(240_000);
test.skip(!process.env.RAINDROP_E2E_OPENCODE_CHAT, "Set RAINDROP_E2E_OPENCODE_CHAT=1 to run the real OpenCode Workshop chat e2e.");

test("workshop chat: opencode provider can answer a simple prompt", async ({ page, workshop }) => {
  requireBinaryOrThrow("opencode", "bun add -g opencode-ai");

  await page.goto(workshop.url);
  await page.getByRole("button", { name: /^Ask (Claude Code|Codex|OpenCode)$/ }).click();
  await page.getByRole("button", { name: /OpenCode$/ }).first().click();
  await page.getByRole("button", { name: /^Connect OpenCode$/ }).click();
  await page.getByRole("button", { name: /^New chat$/ }).click();

  const composer = page.locator('textarea[placeholder="Ask OpenCode..."]');
  await expect(composer).toBeVisible();
  await composer.fill("Reply with exactly: OPENCODE-E2E-SIGNAL");
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/agent/messages") && response.request().method() === "POST",
    { timeout: 180_000 },
  );
  await page.locator('button[title="Send"]').click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.text).toBe("OPENCODE-E2E-SIGNAL");
  expect(body.session?.messages?.some((message: { role?: string; content?: string }) => (
    message.role === "assistant" && message.content === "OPENCODE-E2E-SIGNAL"
  ))).toBe(true);

  await expect(page.locator(".assistant-bubble", { hasText: "OPENCODE-E2E-SIGNAL" })).toBeVisible();
});

import { expect, test } from "./fixtures";
import { requireBinaryOrThrow } from "./helpers";

test.setTimeout(240_000);
test.skip(!process.env.RAINDROP_E2E_OPENCODE_CHAT, "Set RAINDROP_E2E_OPENCODE_CHAT=1 to run the real OpenCode Workshop chat e2e.");

test("workshop chat: opencode provider can answer a simple prompt", async ({ page, workshop }) => {
  requireBinaryOrThrow("opencode", "bun add -g opencode-ai");

  await page.goto(workshop.url);
  await page.getByRole("button", { name: /^OpenCode$/ }).click();
  await page.getByRole("button", { name: /^Connect OpenCode$/ }).click();
  await page.getByRole("button", { name: /^New chat$/ }).click();

  const composer = page.locator('textarea[placeholder="Ask OpenCode..."]');
  await expect(composer).toBeVisible();
  await composer.fill("Reply with exactly: OPENCODE-E2E-SIGNAL");
  await page.locator('button[title="Send"]').click();

  await expect(page.getByText(/OPENCODE-E2E-SIGNAL/i).first()).toBeVisible({ timeout: 180_000 });
});

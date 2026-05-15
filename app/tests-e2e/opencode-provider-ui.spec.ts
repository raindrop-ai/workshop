import { expect, test } from "./fixtures";

test("workshop chat: OpenCode provider UI renders remediation details", async ({ page, workshop }) => {
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agent: { provider: "opencode", mode: "opencode_exec_stream", state: "gray" },
        claude_code: { mode: "cli_stream", state: "gray" },
        codex: { mode: "codex_exec_stream", state: "green" },
        opencode: { mode: "opencode_exec_stream", state: "gray" },
      }),
    });
  });

  await page.goto(workshop.url);
  await page.getByRole("button", { name: /^Ask (Claude Code|Codex|OpenCode)$/ }).click();

  const providerButton = page.getByRole("button", { name: /OpenCode$/ }).first();
  await expect(providerButton).toBeVisible();
  await providerButton.click();
  await page.getByRole("button", { name: /^Connect OpenCode$/ }).click();

  const unavailable = page.getByRole("button", { name: /OpenCode unavailable/i });
  await expect(unavailable).toBeVisible();
  await unavailable.click();

  const firstTime = page.getByRole("button", { name: /First time\?/i });
  await expect(firstTime).toBeVisible();
  await firstTime.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("~/.config/opencode/opencode.json")).toBeVisible();
  await expect(page.getByText("/absolute/path/to/workshop/src/index.ts")).toBeVisible();
  await expect(page.getByText(/Workshop chat streams through your local OpenCode CLI/i)).toBeVisible();
});

import { expect, test } from "bun:test";

test("a missing browser launcher does not fail the calling process", async () => {
  const moduleUrl = new URL("../src/open-browser.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        // Select the xdg-open branch even when this test runs on Windows.
        Object.defineProperty(process, "platform", { value: "linux" });
        process.env.PATH = "";
        const { openInBrowser } = await import(${JSON.stringify(moduleUrl)});
        openInBrowser("http://localhost:5899");
      `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

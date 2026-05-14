import { expect, test } from "bun:test";
import fs from "node:fs";
import { _internal } from "../src/opencode-sessions";

const exportText = fs.readFileSync(new URL("./fixtures/opencode-export.txt", import.meta.url), "utf8");

test("OpenCode session list JSON is parsed and filtered by cwd", () => {
  const rows = _internal.parseSessionList(JSON.stringify([
    {
      id: "ses_1d7816c6effegz7vOFe5SpVL6r",
      title: "New session - 2026-05-14T21:57:24.497Z",
      updated: 1778795844550,
      created: 1778795844497,
      directory: "/home/runner/work/workshop/workshop",
    },
    {
      id: "ses_other",
      title: "Other",
      updated: 1778795844550,
      created: 1778795844497,
      directory: "/tmp/other",
    },
  ]), "/home/runner/work/workshop/workshop");

  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe("ses_1d7816c6effegz7vOFe5SpVL6r");
});

test("OpenCode export text parses into assistant/user messages and blocks", () => {
  const parsed = _internal.parseExport(exportText);
  expect(parsed?.info?.id).toBe("ses_1d7816c6effegz7vOFe5SpVL6r");

  const messages = _internal.parseMessages(parsed?.messages);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.role).toBe("user");
  expect(messages[1]?.role).toBe("assistant");
  expect(messages[1]?.content).toContain("hi");
  expect(messages[1]?.blocks).toEqual([
    { type: "thinking", text: "Looking through the request." },
    {
      type: "tool",
      id: "tool_1",
      name: "read_file",
      input_preview: '{\n  "path": "README.md"\n}',
      output_preview: "# Demo",
      ok: true,
    },
    { type: "text", text: "hi" },
  ]);
});

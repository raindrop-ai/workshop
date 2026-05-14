import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

test("createAnnotation accepts opencode as a source", async () => {
  process.env.RAINDROP_WORKSHOP_DB_PATH = path.join(os.tmpdir(), `workshop-annotations-${Date.now()}.db`);
  const { createAnnotation } = await import("../src/annotations");
  const { closeDb } = await import("../src/db");

  const annotation = createAnnotation({
    run_id: "run-opencode-test",
    kind: "note",
    source: "opencode",
    note: "captured from OpenCode",
  });

  expect(annotation.source).toBe("opencode");
  closeDb();
});

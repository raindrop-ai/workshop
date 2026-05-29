import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeDb, queryTraces } from "../src/db";

let tmpDir: string | null = null;

function useTempDb() {
  closeDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-query-traces-"));
  process.env.RAINDROP_WORKSHOP_DB_PATH = path.join(tmpDir, "test.db");
}

afterEach(() => {
  closeDb();
  delete process.env.RAINDROP_WORKSHOP_DB_PATH;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("queryTraces SQL guard", () => {
  test("allows ordinary read-only trace queries", () => {
    useTempDb();

    const result = queryTraces("SELECT COUNT(*) AS n FROM runs");

    expect(result.rows).toEqual([{ n: 0 }]);
    expect(result.truncated).toBe(false);
  });

  test("rejects SQL functions that can amplify output before maxBytes applies", () => {
    useTempDb();

    expect(() => queryTraces("SELECT hex(randomblob(5000000)) AS payload")).toThrow(
      /amplify output size/,
    );
    expect(() => queryTraces('SELECT "randomblob"(5000000) AS payload')).toThrow(
      /amplify output size/,
    );
  });

  test("rejects recursive CTEs that can burn CPU before row limits apply", () => {
    useTempDb();

    expect(() =>
      queryTraces("WITH RECURSIVE cnt(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM cnt) SELECT x FROM cnt"),
    ).toThrow(/recursive CTEs/);
  });
});

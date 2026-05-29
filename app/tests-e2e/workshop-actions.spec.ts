import { spawnSync } from "node:child_process";
import { test, expect, REPO_ROOT_PATH } from "./fixtures";
import { readWorkshopRun, readWorkshopSpans } from "./helpers";

// Workshop-only specs: exercise the workshop daemon + UI directly without
// involving any example app or external LLM. Seeded fixtures from
// `scripts/seed-traces.ts` give us deterministic data, so these stay
// fast (no LLM round-trip) and run on every PR via the cheap CI lane.
//
// Fixture 1 (`fixtureSuccessfulEdit`) has a pinned trace id of
// `00000000000000000000000000000001`, event_name=`code-agent`, and 6
// spans (1 INTERNAL + 3 LLM_GENERATION + 2 TOOL_CALL). The seed script
// is the source of truth — if it changes, update these numbers in lock
// step with that change.
const FIXTURE_RUN_ID = "00000000000000000000000000000001";
const FIXTURE_CONVO_SIBLING_RUN_ID = "00000000000000000000000000000002";
const FIXTURE_EVENT_NAME = "code-agent";
const FIXTURE_SPAN_COUNT = 6;

async function seedFixtures(workshopUrl: string) {
  const seed = spawnSync("bun", ["scripts/seed-traces.ts"], {
    cwd: REPO_ROOT_PATH,
    env: { ...process.env, RAINDROP_WORKSHOP_URL: workshopUrl },
    stdio: "inherit",
  });
  expect(seed.status, "seed-traces.ts failed").toBe(0);
}

async function clearWorkshop(workshopUrl: string) {
  const res = await fetch(`${workshopUrl}/api/clear`, { method: "POST" });
  expect(res.ok, `POST /api/clear -> ${res.status}`).toBe(true);
}

async function saveRun(workshopUrl: string, runId: string) {
  const detailRes = await fetch(`${workshopUrl}/api/runs/detail/${encodeURIComponent(runId)}`);
  expect(detailRes.ok, `GET /api/runs/detail/${runId} -> ${detailRes.status}`).toBe(true);
  const detail = await detailRes.json() as {
    run: {
      id: string;
      event_name?: string | null;
      name?: string | null;
      user_id?: string | null;
      convo_id?: string | null;
      started_at: number;
    };
  };
  const run = detail.run;
  const saveRes = await fetch(`${workshopUrl}/api/saved-runs/events/${encodeURIComponent(runId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: run.id,
      event_name: run.event_name ?? run.name ?? run.id.slice(0, 12),
      user_id: run.user_id ?? null,
      convo_id: run.convo_id ?? null,
      timestamp: new Date(run.started_at).toISOString(),
      user_input: "Fix the typo in README.md",
      assistant_output: null,
      saved_at: Date.now(),
      source: "local",
    }),
  });
  expect(saveRes.ok, `PUT /api/saved-runs/events/${runId} -> ${saveRes.status}`).toBe(true);
}

// Each test gets a clean slate. Tests that need fixtures call seedFixtures
// themselves so it's obvious in the spec what data each one depends on.
test.beforeEach(async ({ workshop }) => {
  await clearWorkshop(workshop.url);
});

test("workshop UI: clear button empties runs list and DB", async ({ page, workshop }) => {
  await seedFixtures(workshop.url);

  const before = (await (await fetch(`${workshop.url}/api/runs?limit=5000`)).json()) as unknown[];
  expect(before.length).toBeGreaterThanOrEqual(3);

  await page.goto(workshop.url);
  page.on("dialog", (d) => d.accept());

  const clearBtn = page.getByRole("button", { name: /^clear$/i });
  await expect(clearBtn).toBeVisible({ timeout: 10_000 });
  await clearBtn.click();

  await expect
    .poll(async () => ((await (await fetch(`${workshop.url}/api/runs?limit=5000`)).json()) as unknown[]).length, {
      timeout: 10_000,
    })
    .toBe(0);
});

test("workshop UI: run list shows seeded runs, search filters them", async ({ page, workshop }) => {
  await seedFixtures(workshop.url);

  await page.goto(workshop.url);

  // All 3 seeded runs land in the sidebar as <div data-run-id="..."> wrappers.
  // The seed script always writes salt=0 fixtures, so trace ids 1/2/3 are stable.
  const allRows = page.locator("[data-run-id]");
  await expect.poll(async () => allRows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect(page.locator(`[data-run-id="${FIXTURE_RUN_ID}"]`)).toBeVisible();

  // Search filters by event_name / id / prompt. `code-agent` matches every
  // fixture; a deliberately bogus query must collapse the list to zero.
  // This guards the search wiring, not the fuzzy-match algorithm.
  const search = page.getByPlaceholder(/search runs/i);
  await search.fill("definitely-not-a-real-event-name-xyz");
  await expect.poll(async () => allRows.count(), { timeout: 5_000 }).toBe(0);

  await search.fill("");
  await expect.poll(async () => allRows.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
});

test("workshop UI: span tree + side panel render seeded run", async ({ page, workshop }) => {
  await seedFixtures(workshop.url);

  // Cross-check the DB before driving the UI — if seeding silently produced
  // the wrong shape, fail with a clear DB-side message rather than a
  // confusing UI assertion failure later.
  const run = await readWorkshopRun(workshop.url, FIXTURE_RUN_ID);
  expect(run, `expected seeded run ${FIXTURE_RUN_ID} in DB`).not.toBeNull();
  expect(run!.event_name).toBe(FIXTURE_EVENT_NAME);
  const dbSpans = await readWorkshopSpans(workshop.url, FIXTURE_RUN_ID);
  expect(dbSpans.length).toBe(FIXTURE_SPAN_COUNT);

  await page.goto(`${workshop.url}/runs/${FIXTURE_RUN_ID}`);

  // Header shows the run's event_name.
  await expect(page.getByText(FIXTURE_EVENT_NAME).first()).toBeVisible({ timeout: 10_000 });

  // Span Tree tab: rows are stamped with data-span-row=<id>. Each DB
  // span must surface as a tree row (the renderer may also add synthetic
  // sub-agent boundary rows, so use >= rather than ==). A tree count
  // less than the DB count means the renderer dropped a span or the API
  // hid one.
  await page.getByRole("button", { name: /^span tree$/i }).click();
  const rows = page.locator("[data-span-row]");
  await expect.poll(async () => rows.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(FIXTURE_SPAN_COUNT);
  // Every DB span id must be present as a tree row — ensures the renderer
  // doesn't pad with junk while skipping real spans.
  for (const s of dbSpans) {
    await expect(page.locator(`[data-span-row="${s.id}"]`)).toBeVisible({ timeout: 5_000 });
  }

  // Side panel: clicking a row opens SpanDetail with Input/Output sections.
  // Select a DB-backed span that has both payloads and wait for the routed
  // `/span/:id` selection before asserting the detail pane.
  const detailSpan = dbSpans.find((span) => span.input_payload && span.output_payload);
  expect(detailSpan, "expected at least one seeded span with input and output payloads").toBeTruthy();
  await page.locator(`[data-span-row="${detailSpan!.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/span/${detailSpan!.id}(?:[/?#]|$)`));
  await expect(page.getByText(/^Input$/).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/^Output$/).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Fix the typo in README\.md/).first()).toBeVisible({ timeout: 5_000 });
});

test("workshop UI: new run from SDK appears live in sidebar without reload", async ({ page, workshop }) => {
  // Workshop's value proposition is "watch traces stream in live". The
  // sidebar refetches on every ws message (see RunsPage.tsx ws.onmessage),
  // so a regression that silently drops the broadcast — or one where the
  // sidebar uses a stale snapshot — would only surface in production.
  // Open the UI on an empty workshop, then push one fixture through the
  // OTLP intake and assert the row materializes within a few seconds
  // without any manual reload.
  await page.goto(workshop.url);
  await expect(page.getByText(/no runs/i).first()).toBeVisible({ timeout: 10_000 });

  await seedFixtures(workshop.url);

  const row = page.locator(`[data-run-id="${FIXTURE_RUN_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
});

test("workshop UI: switching between runs preserves each run's span tree", async ({ page, workshop }) => {
  // PR #100-class regression: UI state silently desynced from data on a
  // transition (the chat pane cleared streamed blocks before the
  // transcript replaced them). The analogous risk in this app is the
  // run-detail pane carrying stale span data when the user clicks back
  // to a previously-viewed run — e.g. an over-aggressive memoization key
  // or a missing dependency in a useEffect. Switching A → B → A and
  // asserting both renders cover that class without coupling to any
  // specific implementation detail.
  await seedFixtures(workshop.url);

  const RUN_A = "00000000000000000000000000000001"; // 6 spans, agent.turn root
  const RUN_B = "00000000000000000000000000000003"; // 8 spans, includes subagent.review

  const spansA = await readWorkshopSpans(workshop.url, RUN_A);
  const spansB = await readWorkshopSpans(workshop.url, RUN_B);
  expect(spansA.length).toBeLessThan(spansB.length); // sanity: distinct shapes

  // Helper: switching runs in the sidebar resets the active tab to the
  // default (Overview), so re-click Span Tree after each navigation.
  const openSpanTree = async () => {
    await page.getByRole("button", { name: /^span tree$/i }).click();
  };

  await page.goto(`${workshop.url}/runs/${RUN_A}`);
  await openSpanTree();
  const rows = page.locator("[data-span-row]");
  // Same `>=` rationale as line 104: the renderer may add synthetic
  // sub-agent boundary rows, so all run-counts use `>=` for consistency.
  await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(spansA.length);
  await expect(page.locator(`[data-span-row="${spansA[0].id}"]`)).toBeVisible();

  // Click into run B in the sidebar — exercises the same code path users
  // hit when bouncing between traces during debugging.
  await page.locator(`[data-run-id="${RUN_B}"]`).click();
  await openSpanTree();
  await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(spansB.length);
  await expect(page.locator(`[data-span-row="${spansB[0].id}"]`)).toBeVisible();
  // Run A's root span must NOT linger in the tree after switching — that
  // would mean we're rendering stale data alongside the new run.
  await expect(page.locator(`[data-span-row="${spansA[0].id}"]`)).toHaveCount(0);

  // Back to A: shape must be identical to the first render, not a stale
  // mix from B. The stale-state check is: A's root re-appears AND B's
  // root is gone — `>=` on count is enough since the per-id assertions
  // pin down identity.
  await page.locator(`[data-run-id="${RUN_A}"]`).click();
  await openSpanTree();
  await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(spansA.length);
  await expect(page.locator(`[data-span-row="${spansA[0].id}"]`)).toBeVisible();
  await expect(page.locator(`[data-span-row="${spansB[0].id}"]`)).toHaveCount(0);
});

test("workshop UI: saved conversation open preserves saved/unsaved route targets", async ({ page, workshop }) => {
  await seedFixtures(workshop.url);
  await saveRun(workshop.url, FIXTURE_RUN_ID);

  await page.goto(`${workshop.url}/saved/${FIXTURE_RUN_ID}/convo`);
  await expect(page.getByRole("button", { name: /^convo$/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^conversation$/i)).toBeVisible({ timeout: 10_000 });

  const openButtons = page.getByRole("button", { name: /^open →$/i });
  await expect(openButtons).toHaveCount(2);

  const openSavedTurn = openButtons.first();
  await expect(openSavedTurn).toBeVisible({ timeout: 5_000 });
  await openSavedTurn.click();
  await expect(page).toHaveURL(new RegExp(`/saved/${FIXTURE_RUN_ID}(?:[/?#]|$)`));

  await page.goto(`${workshop.url}/saved/${FIXTURE_RUN_ID}/convo`);
  await expect(openButtons).toHaveCount(2);
  await openButtons.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${FIXTURE_CONVO_SIBLING_RUN_ID}(?:[/?#]|$)`));
});

test("workshop UI: saved conversation open keeps saved sibling turns in saved route", async ({ page, workshop }) => {
  await seedFixtures(workshop.url);
  await saveRun(workshop.url, FIXTURE_RUN_ID);
  await saveRun(workshop.url, FIXTURE_CONVO_SIBLING_RUN_ID);

  await page.goto(`${workshop.url}/saved/${FIXTURE_RUN_ID}/convo`);
  const openButtons = page.getByRole("button", { name: /^open →$/i });
  await expect(openButtons).toHaveCount(2);

  await openButtons.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/saved/${FIXTURE_CONVO_SIBLING_RUN_ID}(?:[/?#]|$)`));
});

test("workshop UI: deleting a run via API removes it from the sidebar", async ({ page, workshop }) => {
  await seedFixtures(workshop.url);

  await page.goto(workshop.url);
  const targetRow = page.locator(`[data-run-id="${FIXTURE_RUN_ID}"]`);
  await expect(targetRow).toBeVisible({ timeout: 10_000 });

  // DELETE /api/runs/:id is the workhorse for the per-row delete control;
  // the websocket broadcast triggers a sidebar refetch. Without that wiring
  // the UI keeps showing stale runs even after the row is gone from the DB.
  const del = await fetch(`${workshop.url}/api/runs/${FIXTURE_RUN_ID}`, { method: "DELETE" });
  expect(del.ok, `DELETE /api/runs/${FIXTURE_RUN_ID} -> ${del.status}`).toBe(true);

  await expect(targetRow).toHaveCount(0, { timeout: 5_000 });
  // The other two seeded runs must still be present — delete must be scoped,
  // not a stealth `clearAll`.
  await expect.poll(async () => page.locator("[data-run-id]").count(), { timeout: 5_000 }).toBe(2);
});

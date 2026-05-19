import { expect, type Page } from "@playwright/test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { REPO_ROOT_PATH } from "./fixtures";

export type ExampleHandle = {
  url: string;
  port: number;
  stop: () => Promise<void>;
};

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 404) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`example app never came up at ${url}: ${String(lastErr)}`);
}

async function stopProc(p: ChildProcess): Promise<void> {
  if (p.exitCode != null || p.signalCode != null) return;
  return new Promise<void>((resolve) => {
    p.once("exit", () => resolve());
    try { p.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* gone */ }
      resolve();
    }, 2500);
  });
}

type SpawnInternal = {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  port: number;
  label: string;
  bootTimeoutMs?: number;
};

async function spawnAndWait({ cmd, args, cwd, env, port, label, bootTimeoutMs = 15_000 }: SpawnInternal): Promise<ExampleHandle> {
  const proc = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  proc.stdout?.on("data", (d) => logs.push(`[${label} ${port}] ${d}`));
  proc.stderr?.on("data", (d) => logs.push(`[${label} ${port}!] ${d}`));
  const url = `http://localhost:${port}`;
  try {
    await waitForUrl(url, bootTimeoutMs);
  } catch (err) {
    console.error(logs.slice(-80).join(""));
    throw err;
  }
  return { url, port, stop: () => stopProc(proc) };
}

export function spawnTsExample(opts: { name: string; port: number; workshopUrl: string; extraEnv?: NodeJS.ProcessEnv }): Promise<ExampleHandle> {
  return spawnAndWait({
    cmd: "bun",
    args: ["server.ts"],
    cwd: path.join(REPO_ROOT_PATH, "examples", opts.name),
    env: {
      ...process.env,
      ...opts.extraEnv,
      PORT: String(opts.port),
      RAINDROP_LOCAL_DEBUGGER: `${opts.workshopUrl}/v1/`,
    },
    port: opts.port,
    label: opts.name,
  });
}

export function spawnPythonExample(opts: { port: number; workshopUrl: string; venvPython: string }): Promise<ExampleHandle> {
  return spawnAndWait({
    cmd: opts.venvPython,
    args: ["server.py"],
    cwd: path.join(REPO_ROOT_PATH, "examples", "python-chat"),
    env: {
      ...process.env,
      PORT: String(opts.port),
      RAINDROP_LOCAL_DEBUGGER: `${opts.workshopUrl}/v1/`,
    },
    port: opts.port,
    label: "python",
  });
}

export function spawnRustExample(opts: { port: number; workshopUrl: string; binPath: string }): Promise<ExampleHandle> {
  return spawnAndWait({
    cmd: opts.binPath,
    args: [],
    cwd: path.join(REPO_ROOT_PATH, "examples", "rust-chat"),
    env: {
      ...process.env,
      PORT: String(opts.port),
      RAINDROP_LOCAL_DEBUGGER: `${opts.workshopUrl}/v1/`,
    },
    port: opts.port,
    label: "rust",
  });
}

export function spawnGoExample(opts: { port: number; workshopUrl: string; binPath: string }): Promise<ExampleHandle> {
  return spawnAndWait({
    cmd: opts.binPath,
    args: [],
    cwd: path.join(REPO_ROOT_PATH, "examples", "go-chat"),
    env: {
      ...process.env,
      PORT: String(opts.port),
      RAINDROP_LOCAL_DEBUGGER: `${opts.workshopUrl}/v1/`,
    },
    port: opts.port,
    label: "go",
  });
}

export function pickPort(workerIndex: number, slot: number): number {
  // 6800-range avoids workshop fixture (5910+), dev:examples (3000-3030), and macOS X11 (6000).
  // 16 slots per worker covers the example-app fan-out without colliding across workers.
  return 6800 + workerIndex * 16 + slot;
}

/** Throws with a copy-pasteable doppler invocation if any key is missing.
 * Intended for `test.beforeAll(() => requireEnvOrThrow(...))` so a missing
 * secret produces a red, actionable failure instead of a silent skip. */
export function requireEnvOrThrow(...keys: string[]): void {
  const missing = keys.filter((k) => {
    const v = process.env[k];
    return !(typeof v === "string" && v.trim().length > 0);
  });
  if (missing.length === 0) return;
  const list = missing.join(", ");
  const csv = missing.join(",");
  throw new Error(
    `\nmissing required env var(s): ${list}\n\n` +
      `These specs hit real LLMs. Run via doppler:\n` +
      `  doppler run -p dawn -c dev --only-secrets ${csv} -- bun x playwright test\n` +
      `or export ${list} in your shell.\n` +
      `(In CI these are configured as repo secrets — see .github/workflows/e2e-real-llm.yml)\n`,
  );
}

/** Throws if a CLI binary isn't on PATH, with an install hint in the message.
 * Tries `<bin> --version` then `<bin> version` (Go uses the latter). */
export function requireBinaryOrThrow(bin: string, installHint: string): void {
  for (const args of [["--version"], ["version"]]) {
    if (spawnSync(bin, args, { stdio: "ignore" }).status === 0) return;
  }
  throw new Error(`\nrequired binary not found: \`${bin}\`\n\nInstall: ${installHint}\n`);
}

export type ChatTurnResult = {
  workshopUrl: string;
  runId: string;
};

/** Short echo prompt — finishes in 1-3s on every model and embeds a unique
 * substring we can assert on in both `pollOutline` and `verifyRunInWorkshopUi`.
 * Replacing the example's default prompt keeps real-LLM CI runs cheap and
 * deterministic without changing what we exercise (SDK→ingest→DB→render). */
export const TEST_PROMPT = "Echo back exactly the next line and nothing else:\nTESTSIG-cust-acme-001";
export const TEST_PROMPT_RX = /TESTSIG-cust-acme-001/i;

/**
 * Drive the standard chat UI (#prompt + #send + .bubble.bubble-assistant
 * .bubble-link) shared by every example app.
 *
 * `disableTools` flips the optional `#useTools` dropdown to `off`. Useful
 * for slow reasoning models (gpt-5.4-mini) where the tool fan-out can push
 * a single turn well past 60s; we still exercise the SDK→Workshop chain
 * via the streaming text path.
 *
 * `prompt` overrides the textarea content. Defaults to `TEST_PROMPT`.
 */
export async function runStandardChatTurn(
  page: Page,
  exampleUrl: string,
  opts: { sendTimeoutMs?: number; disableTools?: boolean; prompt?: string } = {},
): Promise<ChatTurnResult> {
  await page.goto(exampleUrl);
  await expect(page.locator("#prompt")).toBeVisible();

  if (opts.disableTools) {
    const sel = page.locator("#useTools");
    if ((await sel.count()) > 0) await sel.selectOption("0");
  }

  await page.locator("#prompt").fill(opts.prompt ?? TEST_PROMPT);
  await page.locator("#send").click();

  const link = page.locator(".bubble.bubble-assistant .bubble-link").last();
  await expect(link).toBeVisible({ timeout: opts.sendTimeoutMs ?? 75_000 });

  const workshopUrl = await link.getAttribute("href");
  if (!workshopUrl) throw new Error("workshop link href missing");
  const runId = extractRunIdFromWorkshopUrl(workshopUrl);
  return { workshopUrl, runId };
}

function extractRunIdFromWorkshopUrl(workshopUrl: string): string {
  const runPathMatch = workshopUrl.match(/\/runs\/([^/?#]+)/i);
  const hashMatch = workshopUrl.match(/#([0-9a-f-]+)$/i);
  const runId = runPathMatch?.[1] ?? hashMatch?.[1];
  if (!runId) throw new Error(`unexpected workshop href shape: ${workshopUrl}`);
  return decodeURIComponent(runId);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type RunOutline = {
  run: { id: string; event_name?: string | null; user_id?: string | null; span_count?: number } | null;
  spans: Array<{ id: string; name: string; span_type?: string | null; input_preview?: string; output_preview?: string }>;
  live_events: { count: number; types: Record<string, number> };
  errors: unknown[];
  [k: string]: unknown;
};

/** Predicate factory: outline.run.event_name matches AND `rx` lands in
 * a real input/output payload location — a span's `input_preview` /
 * `output_preview`, or anywhere on the `run` row (covers browser-SDK runs
 * that emit partial events only, where prompt content ends up in the
 * runs table rather than in OTLP spans).
 *
 * Tighter than `JSON.stringify(o).search(rx)` because a prompt sentinel
 * accidentally landing in a span *name*, model id, or `live_events.types`
 * key wouldn't satisfy this predicate. Specs need actual SDK ingest of
 * the prompt payload, not coincidental string overlap. */
export function outlineMatches(eventName: string, rx: RegExp): (o: RunOutline) => boolean {
  return (o) => {
    if (o.run?.event_name !== eventName) return false;
    const inSpanPayload = o.spans.some(
      (s) => rx.test(s.input_preview ?? "") || rx.test(s.output_preview ?? ""),
    );
    const inRunRow = o.run != null && rx.test(JSON.stringify(o.run));
    return inSpanPayload || inRunRow;
  };
}

/**
 * Hit /api/runs/:id/outline (which goes straight through Drizzle) and poll
 * until either:
 *   - the run row is non-null AND `predicate(outline)` returns true, or
 *   - timeout.
 *
 * Returns the populated outline on success. The predicate lets specs assert
 * "input/output payload contains X" without race-vs-flush concerns.
 */
export async function pollOutline(
  workshopUrl: string,
  runId: string,
  predicate: (o: RunOutline) => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RunOutline> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: RunOutline | null = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${workshopUrl}/api/runs/${runId}/outline?payload_preview_chars=600`);
    if (res.ok) {
      last = (await res.json()) as RunOutline;
      if (last.run && predicate(last)) return last;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`outline predicate never satisfied for run ${runId}: last = ${JSON.stringify(last).slice(0, 500)}`);
}

/**
 * Navigate the same browser page to the run's Workshop URL and assert
 * that a substring known to be in the SDK's input/output renders in the
 * DOM. Text-based assertion stays robust as the trace view evolves.
 */
export async function verifyRunInWorkshopUi(
  page: Page,
  workshopUrl: string,
  expected: { textRegex: RegExp },
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  await page.goto(workshopUrl);
  await expect(page.getByText(expected.textRegex).first()).toBeVisible({ timeout: timeoutMs });
}

/**
 * Richer UI verifier intended for the canonical real-LLM spec. Beyond
 * "prompt text is somewhere on the page", this exercises:
 *   - Overview tab: user prompt renders in chat view
 *   - Span Tree tab: at least one [data-span-row] renders
 *   - Span Tree side panel: clicking a row reveals Input/Output sections
 *
 * Each example spec doesn't need this — running it against every example
 * would amplify flake without adding signal. One canonical spec carries
 * the UI-shape contract; the rest stay light via verifyRunInWorkshopUi.
 */
export async function verifyRunDetailUi(
  page: Page,
  workshopUrl: string,
  expected: { textRegex: RegExp; minSpanCount?: number },
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  await page.goto(workshopUrl);

  // Overview tab: the SDK-shipped prompt text must render in the chat view.
  // This is the same surface a user lands on after clicking the example app's
  // "open in workshop" link, so it has to work end-to-end.
  await expect(page.getByText(expected.textRegex).first()).toBeVisible({ timeout: timeoutMs });

  // Span Tree tab: rows are stamped with `data-span-row=<id>` (see
  // SpanTree.tsx). Asserting at least one row exists confirms ingest
  // flushed spans through Drizzle and the renderer accepted them.
  await page.getByRole("button", { name: /^span tree$/i }).click();
  const rows = page.locator("[data-span-row]");
  const min = expected.minSpanCount ?? 1;
  await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(min);

  // Side panel: clicking a row opens SpanDetail with Input/Output sections.
  // Pick a span that actually has both payloads; root/internal spans from some
  // providers can be input-only, so "first row" is not a stable detail target.
  const runId = extractRunIdFromWorkshopUrl(workshopUrl);
  const detailSpan = (await fetchSpansViaApi(new URL(workshopUrl).origin, runId))
    .find((span) => span.input_preview && span.output_preview);
  if (!detailSpan) throw new Error(`no span with input and output payload found for run ${runId}`);
  await page.locator(`[data-span-row="${detailSpan.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/span/${escapeRegex(encodeURIComponent(detailSpan.id))}(?:[/?#]|$)`));
  await expect(page.getByText(/^Input$/).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/^Output$/).first()).toBeVisible({ timeout: 5_000 });
}

export type DbRunRow = {
  id: string;
  event_name: string | null;
  user_id: string | null;
  convo_id: string | null;
};

// `input_payload` / `output_payload` are populated from the daemon's
// `input_preview` / `output_preview` fields, which are SUBSTR(raw_column, 1, N)
// (N=400 here, see `payload_preview_chars` query string). They're not
// derived from a different source, so a regression that truncated the raw
// column would also truncate these. Naming matches the underlying DB
// column so spec code stays readable.
export type DbSpanRow = {
  id: string;
  run_id: string;
  name: string;
  span_type: string | null;
  status: string | null;
  input_payload: string | null;
  output_payload: string | null;
};

/** Fetch shape-of-spans data via the workshop's own HTTP API.
 *
 * Previously we shelled out to `bun -e` and opened the sqlite file with
 * `bun:sqlite` directly. That ran into bun 1.3.10 (macOS) seeing
 * "no such table: spans" mid-WAL: the daemon's writes lived only in the
 * WAL file, and a sibling process opening the same file on APFS didn't
 * see the WAL pages until checkpoint. Going through the daemon's HTTP
 * API uses its existing in-process sqlite handle, which obviously sees
 * its own writes — no cross-process WAL coupling required.
 *
 * Same assertions are still meaningful: `/api/runs/:id/spans` returns
 * `span_type`, `model`, and `SUBSTR(input_payload, 1, payload_preview_chars)`
 * as `input_preview`. Asking for 400 chars covers the short echo prompt
 * sentinel we test against. */
async function fetchSpansViaApi(
  workshopUrl: string,
  runId: string,
): Promise<{ id: string; name: string; span_type: string | null; status: string | null; input_preview: string; output_preview: string; model: string | null; tokens: { in: number; out: number } }[]> {
  const res = await fetch(
    `${workshopUrl}/api/runs/${encodeURIComponent(runId)}/spans?limit=500&payload_preview_chars=400`,
  );
  if (!res.ok) {
    throw new Error(`GET /api/runs/${runId}/spans -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<
    {
      id: string;
      name: string;
      span_type: string | null;
      status: string | null;
      input_preview: string;
      output_preview: string;
      model: string | null;
      tokens: { in: number; out: number };
    }[]
  >;
}

export async function readWorkshopRun(workshopUrl: string, runId: string): Promise<DbRunRow | null> {
  const res = await fetch(
    `${workshopUrl}/api/runs/${encodeURIComponent(runId)}/outline?payload_preview_chars=0`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /api/runs/${runId}/outline -> ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { run: DbRunRow | null };
  return body.run ?? null;
}

export async function readWorkshopSpans(workshopUrl: string, runId: string): Promise<DbSpanRow[]> {
  const spans = await fetchSpansViaApi(workshopUrl, runId);
  return spans.map((s) => ({
    id: s.id,
    run_id: runId,
    name: s.name,
    span_type: s.span_type,
    status: s.status,
    input_payload: s.input_preview || null,
    output_payload: s.output_preview || null,
  }));
}

export type LlmSpanRow = {
  name: string;
  span_type: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
};

/**
 * Per-SDK trace SHAPE assertion. Catches regressions where the example app's
 * SDK wrapper silently stops attributing spans to LLM calls or stops
 * propagating the model string into the span row.
 *
 * What we assert (and why each is robust):
 *   1. At least one span has span_type IN ('LLM', 'LLM_GENERATION').
 *      Every SDK in the matrix wraps an LLM call as one of these two
 *      types (observed locally: openai/anthropic/ai-sdk/pi-agent/python/
 *      go/rust all emit `LLM`; claude-agent-sdk emits the outer
 *      `LLM_GENERATION` wrapper + an inner `LLM` child). If the wrapper
 *      breaks, this drops to zero.
 *   2. That span has a non-null `model` column.
 *      Proves the SDK propagated the model string. If the SDK regresses
 *      to not stamping the model, the column becomes NULL.
 *   3. If `modelRegex` is provided, the model matches it.
 *      The example apps hardcode a default model (e.g. gpt-5.4-mini for
 *      OpenAI-backed examples, claude-sonnet-4-6 for anthropic-chat).
 *      Asserting the regex catches regressions where the SDK overwrites
 *      `model` with a wrong value (e.g. "unknown" or a stale default).
 *
 * What we DON'T assert (and why):
 *   - Exact span count. LLM behavior is non-deterministic for tool-using
 *     examples (pi-agent, rust-chat, openai-chat): the model may or may
 *     not call tools for an echo prompt. We'd be testing the LLM, not
 *     the SDK.
 *   - input_tokens / output_tokens. Streaming responses don't always
 *     populate usage (provider-dependent); the column is NULL in many
 *     real runs. False-positive risk too high.
 *   - Specific tool names. Same non-determinism as span count.
 *   - `provider` column. Currently NULL in all observed runs.
 */
export async function assertLlmSpanShape(
  workshopUrl: string,
  runId: string,
  opts: { modelRegex?: RegExp; requireModelColumn?: boolean } = {},
): Promise<LlmSpanRow> {
  const all = await fetchSpansViaApi(workshopUrl, runId);
  const rows: LlmSpanRow[] = all
    .filter((s) => s.span_type === "LLM" || s.span_type === "LLM_GENERATION")
    .map((s) => ({
      name: s.name,
      span_type: s.span_type as string,
      model: s.model,
      input_tokens: s.tokens.in,
      output_tokens: s.tokens.out,
    }));
  if (rows.length === 0) {
    throw new Error(
      `expected at least one LLM/LLM_GENERATION span for run ${runId}, got 0 — ` +
        "SDK is not attributing spans to LLM calls",
    );
  }
  const requireModelColumn = opts.requireModelColumn ?? opts.modelRegex !== undefined;
  const withModel = rows.find((r) => r.model != null && r.model.length > 0);
  if (requireModelColumn && !withModel) {
    throw new Error(
      `expected at least one LLM span to have non-null model for run ${runId}, ` +
        `got ${JSON.stringify(rows)} — SDK is not propagating model into spans.model column`,
    );
  }
  if (opts.modelRegex && withModel && !opts.modelRegex.test(withModel.model ?? "")) {
    throw new Error(
      `expected model to match ${opts.modelRegex} for run ${runId}, ` +
        `got model=${JSON.stringify(withModel.model)}`,
    );
  }
  return withModel ?? rows[0]!;
}

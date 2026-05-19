// Shared workshop-daemon URL helpers used by the example servers that poll
// `/api/convo/...` after a turn to surface a clickable trace URL.

// Mirrors `@raindrop-ai/core`'s `DEFAULT_LOCAL_WORKSHOP_URL`. Used as the
// last-resort fallback when neither RAINDROP_LOCAL_DEBUGGER nor
// RAINDROP_ENDPOINT is set, so the "Open in Workshop" link still resolves
// against the daemon's default port out-of-the-box.
const DEFAULT_WORKSHOP_ENDPOINT = "http://localhost:5899/v1/";

// Computed lazily on call: env vars from `.env` are loaded inside each server
// (via `loadWorkspaceEnv` / `dotenv.config`), which only runs after this module
// has finished evaluating, so we can't capture `process.env` at import time.
function workshopBase(): string {
  const raw =
    process.env.RAINDROP_LOCAL_DEBUGGER ??
    process.env.RAINDROP_ENDPOINT ??
    DEFAULT_WORKSHOP_ENDPOINT;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

export interface WorkshopRow {
  id: string;
  started_at?: number;
  event_id?: string;
  event_name?: string;
}

export interface ResolveWorkshopRunUrlOptions {
  endpoint: string;
  match: (row: WorkshopRow) => boolean;
  attempts?: number;
  intervalMs?: number;
}

export async function resolveWorkshopRunUrl({
  endpoint,
  match,
  attempts = 10,
  intervalMs = 200,
}: ResolveWorkshopRunUrlOptions): Promise<string | null> {
  const base = workshopBase();
  if (!base) return null;
  for (let i = 0; i < attempts; i++) {
    try {
      const rows = (await (await fetch(`${base}${endpoint}`)).json()) as WorkshopRow[];
      const hit = rows.find(match);
      if (hit) return `${base}/runs/${encodeURIComponent(hit.id)}`;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

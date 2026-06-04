import { API_KEY_ENV_VAR, HOSTED_MCP_URL } from "./constants";
import { acquireOAuthAccessToken, probeStoredAccessToken } from "./oauth";
import { clearAuthStore, loadAuthStore, saveAuthStore, type AuthStore } from "./token-store";
import { fetchWriteKey } from "./write-key";

export interface LoginOptions {
  /** Hosted MCP URL to authenticate against (defaults to the prod endpoint). */
  serverUrl?: string;
  /** Org API key for non-interactive auth (defaults to RAINDROP_API_KEY). */
  apiKey?: string;
  /** Treat a missing TTY as fatal when an interactive browser flow is required. */
  interactive?: boolean;
}

export interface LoginResult {
  /** Bearer token usable against the hosted MCP. Secret — never log it. */
  accessToken: string;
  /** Org write key, fetched during login. Secret — never log it. */
  writeKey: string;
  /** True when valid stored credentials were reused (no browser shown). */
  reused: boolean;
  /**
   * True when the write key was persisted to the OAuth store for later reuse by
   * `raindrop cloud setup`. False on the API-key path, which is stateless and
   * doesn't touch the store (the key is re-derived from the env var each run).
   */
  cached: boolean;
}

class LoginError extends Error {}

/**
 * Whether a fresh browser sign-in may be attempted. OAuth needs a browser +
 * loopback callback, not stdin, so any signal that a real terminal is attached
 * is enough. Under `curl … | bash` stdin is the pipe (not a TTY), but
 * `install.sh` sets RAINDROP_SETUP_TTY=1 once it has confirmed a usable
 * terminal (`[ -r /dev/tty ] && [ -t 1 ]`) — honor it so the onboarding
 * one-liner can open the browser, matching how `raindrop setup` (init.ts)
 * opens /dev/tty under the same signal. Exported for unit testing.
 */
export function hasInteractiveTerminal(): boolean {
  if (process.env.RAINDROP_SETUP_TTY === "1") return true;
  return Boolean((process.stdin as { isTTY?: boolean }).isTTY);
}

/**
 * Ensure we hold a usable Raindrop access token, then fetch + cache the org
 * write key. Reuses valid stored credentials without prompting; only opens a
 * browser when a fresh sign-in is genuinely required. Shared by `raindrop
 * login` and `raindrop cloud setup` so setup stays a single command.
 */
export async function ensureLoggedIn(opts: LoginOptions = {}): Promise<LoginResult> {
  const serverUrl = opts.serverUrl ?? HOSTED_MCP_URL;
  const apiKey = opts.apiKey ?? process.env[API_KEY_ENV_VAR]?.trim();

  // 1. Non-interactive path: an org API key is its own bearer token. This is a
  //    fresh authentication (not reused stored creds), so reused=false even
  //    though no browser is shown. Deliberately stateless w.r.t. the OAuth
  //    store: we do NOT cache the write key here, because doing so would leave
  //    an API-key org's write key co-mingled with whatever OAuth tokens a prior
  //    interactive `raindrop login` left behind (a different account/org). The
  //    write key is returned to the caller and written to .env regardless, and
  //    nothing reuses the cached value, so persisting it only risks confusion.
  if (apiKey) {
    const writeKey = await fetchWriteKey({ apiKey, serverUrl });
    return { accessToken: apiKey, writeKey, reused: false, cached: false };
  }

  // 2. Smart login-state check: reuse stored tokens (refreshing silently) and
  //    skip the browser when we're already signed in.
  const existing = await probeStoredAccessToken(serverUrl);
  if (existing) {
    const writeKey = await fetchWriteKey({ accessToken: existing, serverUrl });
    cacheWriteKey(writeKey);
    return { accessToken: existing, writeKey, reused: true, cached: true };
  }

  // 3. Fresh sign-in. The browser flow can't run without a TTY to confirm at.
  if (opts.interactive === false || !hasInteractiveTerminal()) {
    throw new LoginError(headlessAuthError(serverUrl));
  }

  const accessToken = await acquireOAuthAccessToken(serverUrl);
  const writeKey = await fetchWriteKey({ accessToken, serverUrl });
  cacheWriteKey(writeKey);
  return { accessToken, writeKey, reused: false, cached: true };
}

/**
 * Build the headless-mode auth-failure message. `probeStoredAccessToken` returns
 * null for several reasons — no token, an expired/un-refreshable token, or a
 * slow/unreachable MCP that tripped the probe deadline — so a blanket "not signed
 * in" misdiagnoses a user who *does* have stored credentials. Distinguish the two
 * by checking the store: if a token is present, the session just couldn't be
 * verified (retry / re-login), otherwise it's a genuine "no credentials" case.
 */
function headlessAuthError(serverUrl: string): string {
  let hasStoredToken = false;
  try {
    hasStoredToken = Boolean(loadAuthStore().tokens?.access_token);
  } catch {
    // Corrupt/unreadable store — treat as no usable credentials.
  }
  if (hasStoredToken) {
    return (
      `Found a stored Raindrop sign-in but couldn't verify it against ${serverUrl} ` +
      `(it may be unreachable, or the session expired). Retry, or run ` +
      `\`raindrop login\` in an interactive terminal to sign in again.`
    );
  }
  return (
    `Not signed in to Raindrop and no ${API_KEY_ENV_VAR} set. ` +
    `Run \`raindrop login\` in an interactive terminal, or set ${API_KEY_ENV_VAR}.`
  );
}

export function cacheWriteKey(writeKey: string, file?: string): void {
  // Don't let a corrupt/unreadable store abort a login that already succeeded:
  // loadAuthStore() throws on a malformed file, so fall back to a fresh store.
  // saveAuthStore overwrites the file wholesale, repairing it in the process.
  let store: AuthStore;
  try {
    store = loadAuthStore(file);
  } catch {
    store = {};
  }
  store.writeKey = writeKey;
  saveAuthStore(store, file);
}

interface ParsedLoginArgs {
  serverUrl?: string;
  apiKey?: string;
}

/** Reject an explicitly empty `--flag=` value (a usage error rather than a
 * silent fallback, so we never sign in / fetch against an empty URL). The `=`
 * form is unambiguous, so a leading "-" is allowed — e.g. an API key that
 * happens to start with a hyphen. */
function requireValue(flag: string, value: string): string {
  if (value === "") {
    throw new LoginError(`${flag} requires a value`);
  }
  return value;
}

/** Read the value following a space-separated flag, rejecting a missing/empty
 * value or one that is actually the next flag (e.g. `--server-url --api-key=x`).
 * To pass a value beginning with "-", use the unambiguous `--flag=value` form. */
function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new LoginError(`${flag} requires a value`);
  }
  return value;
}

function parseLoginArgs(argv: string[]): ParsedLoginArgs {
  const out: ParsedLoginArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--server-url=")) out.serverUrl = requireValue("--server-url", arg.slice("--server-url=".length));
    else if (arg === "--server-url") out.serverUrl = takeValue(argv, i++, arg);
    else if (arg.startsWith("--api-key=")) out.apiKey = requireValue("--api-key", arg.slice("--api-key=".length));
    else if (arg === "--api-key") out.apiKey = takeValue(argv, i++, arg);
    else if (arg === "-h" || arg === "--help") {
      printLoginHelp();
      process.exit(0);
    } else {
      throw new LoginError(`unknown flag: ${arg}`);
    }
  }
  return out;
}

function printLoginHelp(): void {
  console.log(`raindrop login — sign in to Raindrop cloud

USAGE
    raindrop login [flags]

WHAT IT DOES
    Signs in via your browser (OAuth) and fetches your org write key. If you're
    already signed in, it confirms and moves on without reopening the browser.

FLAGS
    --api-key=<key>     Authenticate non-interactively with an org API key
                        (or set ${API_KEY_ENV_VAR}). Skips the browser.
    --server-url=<url>  Override the hosted MCP endpoint (advanced / staging).
    -h, --help          Print this help.
`);
}

export async function cmdLogin(argv: string[]): Promise<number> {
  let args: ParsedLoginArgs;
  try {
    args = parseLoginArgs(argv);
  } catch (err) {
    if (err instanceof LoginError) {
      console.error(err.message);
      console.error("run `raindrop login --help` for usage.");
      return 64;
    }
    throw err;
  }

  try {
    const result = await ensureLoggedIn({ serverUrl: args.serverUrl, apiKey: args.apiKey });
    if (result.reused) {
      console.log("\x1b[32m✓\x1b[0m You're already signed in to Raindrop.");
    } else {
      console.log("\x1b[32m✓\x1b[0m Signed in to Raindrop.");
    }
    if (result.cached) {
      console.log("\x1b[2mWrite key retrieved and cached for `raindrop cloud setup`.\x1b[0m");
    } else {
      console.log("\x1b[2mWrite key retrieved. `raindrop cloud setup` will reuse your API key.\x1b[0m");
    }
    return 0;
  } catch (err) {
    console.error(`login failed: ${(err as Error).message}`);
    return 1;
  }
}

interface ParsedLogoutArgs {
  help: boolean;
}

function parseLogoutArgs(argv: string[]): ParsedLogoutArgs {
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { help: true };
    throw new LoginError(`unknown flag: ${arg}`);
  }
  return { help: false };
}

export interface LogoutOptions {
  /** Override the auth store path (testing). Defaults to ~/.raindrop/setup-auth.json. */
  file?: string;
}

export async function cmdLogout(argv: string[], opts: LogoutOptions = {}): Promise<number> {
  let args: ParsedLogoutArgs;
  try {
    args = parseLogoutArgs(argv);
  } catch (err) {
    if (err instanceof LoginError) {
      console.error(err.message);
      return 64;
    }
    throw err;
  }
  if (args.help) {
    console.log(`raindrop logout — clear stored Raindrop credentials

USAGE
    raindrop logout

Removes the cached OAuth tokens + write key (~/.raindrop/setup-auth.json).
`);
    return 0;
  }

  // Determine prior state for messaging, but never let a corrupt/unreadable
  // store block sign-out: loadAuthStore() throws on a malformed file, so treat
  // that as "had credentials" and clear it regardless.
  let hadCreds: boolean;
  try {
    const before = loadAuthStore(opts.file);
    hadCreds = Boolean(before.tokens || before.clientInformation || before.writeKey);
  } catch {
    hadCreds = true;
  }
  clearAuthStore(opts.file);
  if (hadCreds) {
    console.log("\x1b[32m✓\x1b[0m Signed out of Raindrop.");
  } else {
    console.log("You're not signed in.");
  }
  return 0;
}

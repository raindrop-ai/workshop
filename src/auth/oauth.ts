import { randomBytes } from "node:crypto";
import http from "node:http";

import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { VERSION } from "../version";
import { openInBrowser } from "../open-browser";
import { OAUTH_SCOPE } from "./constants";
import { loadAuthStore, saveAuthStore } from "./token-store";

const CALLBACK_PATH = "/oauth/callback";

/** Default time to wait for the user to finish signing in before giving up. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Upper bound on the non-interactive login-state probe. The probe runs before
 * the headless fast-fail guard, so without a deadline a stored token plus a
 * slow/unreachable MCP would hang the CLI (a TCP connect can stall for minutes)
 * instead of fast-failing. On timeout we treat login as unconfirmed and let the
 * caller fall through to its fast-fail / browser path.
 */
const PROBE_TIMEOUT_MS = 10 * 1000;

/** Resolve the probe deadline, honoring a test-only env override at call time. */
function probeTimeoutMs(): number {
  return Number(process.env.RAINDROP_PROBE_TIMEOUT_MS) || PROBE_TIMEOUT_MS;
}

interface ProviderOptions {
  /** When false, the OAuth flow never launches a browser (used to probe login state). */
  interactive?: boolean;
}

class CliOAuthProvider implements OAuthClientProvider {
  private state_: string | undefined;
  /** Set when the SDK asked us to redirect (i.e. a browser sign-in is required). */
  redirectRequested = false;
  /**
   * Cleared by `abandon()` so a timed-out probe whose `auth()` is still in
   * flight can no longer mutate the shared on-disk store. Without this, a stale
   * probe could race the subsequent real sign-in and corrupt `setup-auth.json`
   * (overlapping PKCE verifiers / tokens / client info).
   */
  private live = true;

  constructor(
    private readonly redirectUri: string,
    private readonly options: ProviderOptions = { interactive: true },
  ) {}

  /** Stop honoring writes from this provider (see `live`). Irreversible. */
  abandon(): void {
    this.live = false;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Raindrop CLI",
      client_uri: "https://github.com/raindrop-ai/workshop",
      software_id: "raindrop-cli",
      software_version: VERSION,
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
    };
  }

  state(): string {
    if (!this.state_) this.state_ = randomBytes(16).toString("hex");
    return this.state_;
  }

  get expectedState(): string | undefined {
    return this.state_;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return loadAuthStore().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    if (!this.live) return;
    const store = loadAuthStore();
    store.clientInformation = clientInformation;
    saveAuthStore(store);
  }

  tokens(): OAuthTokens | undefined {
    return loadAuthStore().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    if (!this.live) return;
    const store = loadAuthStore();
    store.tokens = tokens;
    saveAuthStore(store);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.redirectRequested = true;
    // In probe mode we only want to know whether a browser sign-in would be
    // required — never actually open one.
    if (this.options.interactive === false) return;
    const href = authorizationUrl.toString();
    console.log("\n\x1b[1mOpening your browser to sign in to Raindrop…\x1b[0m");
    console.log(`\x1b[2mIf it doesn't open automatically, visit:\n  ${href}\x1b[0m\n`);
    openInBrowser(href);
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (!this.live) return;
    const store = loadAuthStore();
    store.codeVerifier = codeVerifier;
    saveAuthStore(store);
  }

  codeVerifier(): string {
    const verifier = loadAuthStore().codeVerifier;
    if (!verifier) throw new Error("Missing PKCE code verifier — restart the login flow.");
    return verifier;
  }
}

interface CallbackResult {
  code: string;
  state: string | null;
}

interface CallbackServer {
  port: number;
  redirectUri: string;
  waitForCode: (expectedState: string | undefined, timeoutMs?: number) => Promise<string>;
  close: () => void;
}

function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    // The browser redirect can land before (or after) `waitForCode` is called,
    // so buffer whichever arrives first and flush it to the waiter.
    let pending: { result?: CallbackResult; error?: Error } | undefined;
    let onResult: ((result: CallbackResult) => void) | undefined;
    let onError: ((err: Error) => void) | undefined;

    const deliverResult = (result: CallbackResult) => {
      if (onResult) onResult(result);
      else pending = { result };
    };
    const deliverError = (error: Error) => {
      if (onError) onError(error);
      else pending = { error };
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const finish = (status: number, message: string) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(
          `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center">` +
            `<h2>${message}</h2><p>You can close this tab and return to your terminal.</p></body></html>`,
        );
      };

      if (error) {
        finish(400, "Sign-in failed.");
        deliverError(new Error(`Authorization failed: ${error}`));
        return;
      }
      if (!code) {
        finish(400, "Sign-in failed.");
        deliverError(new Error("Authorization response missing code."));
        return;
      }
      finish(200, "Raindrop is connected.");
      deliverResult({ code, state });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not determine local callback port."));
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}${CALLBACK_PATH}`;
      resolve({
        port: addr.port,
        redirectUri,
        waitForCode: (expectedState, timeoutMs = CALLBACK_TIMEOUT_MS) =>
          new Promise<string>((res, rej) => {
            const timer = setTimeout(() => {
              onResult = undefined;
              onError = undefined;
              rej(new Error("Timed out waiting for the browser sign-in to complete."));
            }, timeoutMs);

            onResult = ({ code, state }) => {
              clearTimeout(timer);
              // When we issued a state, the callback MUST echo it back exactly —
              // a missing or mismatched value is rejected.
              if (expectedState && state !== expectedState) {
                rej(new Error("OAuth state mismatch — aborting for security."));
                return;
              }
              res(code);
            };
            onError = (err) => {
              clearTimeout(timer);
              rej(err);
            };

            // Flush a callback that arrived before we started waiting.
            if (pending?.result) {
              const result = pending.result;
              pending = undefined;
              onResult(result);
            } else if (pending?.error) {
              const err = pending.error;
              pending = undefined;
              onError(err);
            }
          }),
        close: () => server.close(),
      });
    });
  });
}

/**
 * Probe whether we already hold a usable token for `serverUrl` without ever
 * opening a browser. Returns the access token when the stored credentials are
 * still valid (refreshing silently if a refresh token is present), or null when
 * a fresh interactive sign-in would be required.
 */
export async function probeStoredAccessToken(serverUrl: string): Promise<string | null> {
  let store: ReturnType<typeof loadAuthStore>;
  try {
    store = loadAuthStore();
  } catch {
    // A corrupt/unreadable store means we can't confirm login non-interactively.
    // Return null (rather than throwing) so the caller falls through to a fresh
    // sign-in, which overwrites and repairs the store on success.
    return null;
  }
  if (!store.tokens?.access_token) return null;

  // Bind to an ephemeral port so the SDK's redirect-uri bookkeeping stays valid
  // even though we never expect to use it in probe mode.
  const callback = await startCallbackServer();
  const provider = new CliOAuthProvider(callback.redirectUri, { interactive: false });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bound the network discovery/refresh so a slow or unreachable MCP can't
    // hang the probe (and, with it, the headless fast-fail that runs after it).
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        // The SDK's auth() can't be cancelled, so neutralize this provider:
        // once we've timed out and the caller moves on to a real sign-in, the
        // still-in-flight probe must not write to the shared store.
        provider.abandon();
        resolve(null);
      }, probeTimeoutMs());
    });
    // auth() can't be cancelled, so when the timeout wins the race it keeps
    // running and will eventually reject (e.g. the SDK's own ~60s deadline).
    // Attach a no-op catch so that late rejection can't surface as an unhandled
    // promise rejection and crash the process mid browser sign-in.
    const authPromise = auth(provider, { serverUrl });
    authPromise.catch(() => {});
    const result = await Promise.race([authPromise, timeout]);
    if (!timedOut && result === "AUTHORIZED" && !provider.redirectRequested) {
      const tokens = provider.tokens();
      return tokens?.access_token ?? null;
    }
    return null;
  } catch {
    // A discovery/refresh failure means we can't confirm login non-interactively.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    callback.close();
  }
}

/**
 * Run the interactive OAuth 2.1 browser flow against the hosted MCP server and
 * return a bearer access token. Tokens + client registration are cached under
 * `~/.raindrop/` so subsequent runs skip the browser when still valid.
 */
export async function acquireOAuthAccessToken(serverUrl: string): Promise<string> {
  const callback = await startCallbackServer();
  const provider = new CliOAuthProvider(callback.redirectUri);
  try {
    const result = await auth(provider, { serverUrl });
    if (result !== "AUTHORIZED") {
      // The SDK only asks us to redirect when a browser sign-in is genuinely
      // needed. If it didn't (e.g. discovery failed), there will never be a
      // callback — fail fast instead of blocking for the full timeout.
      if (!provider.redirectRequested) {
        throw new Error(
          "Could not start the Raindrop sign-in flow (the authorization server may be " +
            "unreachable). Check your connection and try again.",
        );
      }
      const code = await callback.waitForCode(provider.expectedState);
      const exchanged = await auth(provider, { serverUrl, authorizationCode: code });
      if (exchanged !== "AUTHORIZED") {
        throw new Error("OAuth token exchange did not complete.");
      }
    }
    const tokens = provider.tokens();
    if (!tokens?.access_token) {
      throw new Error("No access token returned from authorization.");
    }
    return tokens.access_token;
  } finally {
    callback.close();
  }
}

import type express from "express";

/**
 * The local daemon path that masquerades as the hosted Raindrop Cloud MCP
 * endpoint for spawned Claude/Codex subprocesses. The subprocess authenticates
 * to this path with a transient per-spawn bearer token; the daemon resolves
 * that token to the actual Raindrop Query API key and forwards the request to
 * `https://mcp.raindrop.ai/mcp` (or whatever `RAINDROP_CLOUD_MCP_URL` points
 * at). The spawned agent never sees the real key.
 */
export const CLOUD_MCP_PROXY_PATH = "/proxy/cloud-mcp";

/**
 * Headers that must not be copied verbatim from one HTTP hop to another.
 * Source: RFC 7230 §6.1 plus a couple of practical extras that confuse the
 * downstream client when forwarded blind (gzip body announced via
 * `content-encoding` but already-decoded by `fetch`, fixed `content-length`
 * that no longer matches a re-streamed body, etc.).
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const DROP_FROM_UPSTREAM_REQUEST = new Set<string>([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "host",
  "content-length",
  "accept-encoding",
]);

const DROP_FROM_UPSTREAM_RESPONSE = new Set<string>([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
]);

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

export interface CloudMcpProxyOptions {
  /** Returns the upstream MCP URL (e.g. `https://mcp.raindrop.ai/mcp`). */
  upstreamUrl: () => string;
  /**
   * Resolve a presented bearer token to the Raindrop Query API key the daemon
   * should send upstream. Returning null means the token is unknown/expired
   * and the proxy rejects the request with 401.
   */
  resolveBearer: (token: string) => string | null;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createCloudMcpProxy(options: CloudMcpProxyOptions): express.RequestHandler {
  const doFetch = options.fetchImpl ?? fetch;
  return (req, res) => {
    void handleCloudMcpProxy(options, doFetch, req, res);
  };
}

async function handleCloudMcpProxy(
  options: CloudMcpProxyOptions,
  doFetch: typeof fetch,
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const token = bearerTokenFromHeader(req.header("authorization"));
  if (!token) {
    res.status(401).json({ error: "cloud MCP proxy: missing bearer token" });
    return;
  }
  const upstreamKey = options.resolveBearer(token);
  if (!upstreamKey) {
    res.status(401).json({ error: "cloud MCP proxy: invalid or expired bearer token" });
    return;
  }

  const upstreamUrl = options.upstreamUrl();
  const headers = buildUpstreamHeaders(req, upstreamKey);

  // Wire up abort propagation: if the client (or its socket) goes away
  // mid-stream, cancel the upstream fetch so we don't keep the upstream
  // session open. We intentionally do NOT listen on `req.on("close")` —
  // the request stream emits "close" as part of normal completion once the
  // body is consumed, which would abort the upstream fetch prematurely.
  //
  // The socket survives across keep-alive requests, so we must explicitly
  // remove the listener once this request completes — otherwise listeners
  // accumulate and trigger MaxListenersExceededWarning on long-lived
  // keep-alive sessions (e.g. an MCP session that issues many sequential
  // tool calls). Bind cleanup with `res.once("finish"|"close")`.
  const socket = req.socket;
  const abortController = new AbortController();
  const onSocketClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  if (socket) {
    socket.once("close", onSocketClose);
    const cleanup = () => socket.removeListener("close", onSocketClose);
    res.once("finish", cleanup);
    res.once("close", cleanup);
  }

  let body: BodyInit | undefined;
  if (!METHODS_WITHOUT_BODY.has(req.method.toUpperCase())) {
    const buffered = await readRequestBody(req);
    if (buffered) {
      // Some node/bun BodyInit type defs omit Uint8Array; cast through unknown
      // since fetch in both runtimes accepts it for the request body.
      body = new Uint8Array(buffered.buffer, buffered.byteOffset, buffered.byteLength) as unknown as BodyInit;
    }
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await doFetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      signal: abortController.signal,
      redirect: "manual",
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      res.end();
      return;
    }
    res.status(502).json({
      error: `cloud MCP proxy: upstream unreachable (${(err as Error).message ?? "unknown"})`,
    });
    return;
  }

  res.status(upstreamRes.status);
  upstreamRes.headers.forEach((value, name) => {
    if (DROP_FROM_UPSTREAM_RESPONSE.has(name.toLowerCase())) return;
    res.setHeader(name, value);
  });
  res.flushHeaders?.();

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  try {
    await pipeWebStream(upstreamRes.body, res);
  } catch (err) {
    if (!abortController.signal.aborted) {
      res.destroy(err as Error);
      return;
    }
  }
  res.end();
}

/**
 * Parse `Authorization: Bearer <token>` headers. Returns null when missing or
 * malformed. Exported so the daemon's regular request handlers (which also
 * accept the same browser-issued bearer) can share one implementation.
 */
export function bearerTokenFromHeader(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^\s*Bearer\s+(.+)\s*$/i.exec(value);
  return match ? match[1].trim() : null;
}

function buildUpstreamHeaders(req: express.Request, upstreamKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (DROP_FROM_UPSTREAM_REQUEST.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  headers.set("authorization", `Bearer ${upstreamKey}`);
  return headers;
}

async function readRequestBody(req: express.Request): Promise<Buffer | undefined> {
  // Express's body parsers may have already consumed and parsed this body. If
  // so, the parsed JSON is on `req.body` — re-serialize so the upstream gets
  // identical bytes. Otherwise read the raw stream.
  if (req.body !== undefined && req.body !== null && req.readableEnded) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return Buffer.from(req.body);
    return Buffer.from(JSON.stringify(req.body));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function pipeWebStream(stream: ReadableStream<Uint8Array>, res: express.Response): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      const chunk = Buffer.from(value);
      const wantsMore = res.write(chunk);
      if (!wantsMore) {
        await once(res, "drain");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      emitter.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      emitter.removeListener(event, onEvent);
      reject(err);
    };
    emitter.once(event, onEvent);
    emitter.once("error", onError);
  });
}

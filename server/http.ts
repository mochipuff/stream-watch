import { socksDispatcher } from "fetch-socks";
import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici";
import { audit } from "./audit.ts";
import { errorMessage } from "./config.ts";
import { isOnline, reportNetworkFailure, setProbe } from "./connectivity.ts";
import { getSetting, setSetting } from "./db.ts";
import { events } from "./events.ts";

const PROXY_KEY = "proxyUrl";
const PROXY_COOLDOWN_MS = 60_000;
const PROXY_ATTEMPT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 4_000;
const PROBE_URL = "https://www.youtube.com/generate_204";
const DEFAULT_SOCKS_PORT = 1080;

interface Proxy {
  url: string;
  dispatcher: Dispatcher;
  failedAt: number;
  error: string | null;
}

let proxy: Proxy | null = null;

const makeAgent = () => new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS }, keepAliveTimeout: 4_000 });
let direct = makeAgent();

/** The agent for direct requests (also used for Discord). It is replaced after an outage, so no dead keep-alive socket is reused. */
export const directAgent = () => direct;

function buildDispatcher(url: string): Dispatcher {
  const u = new URL(url);
  if (!u.protocol.startsWith("socks")) return new ProxyAgent(url);
  return socksDispatcher({
    type: 5,
    host: u.hostname,
    port: Number(u.port) || DEFAULT_SOCKS_PORT,
    userId: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
  });
}

// The label is what the dashboard and the audit log may show: never the credentials.
function labelOf(url: string) {
  const { protocol, host } = new URL(url);
  return `${protocol}//${host}`;
}

function apply(url: string | null) {
  const previous = proxy;
  proxy = url ? { url, dispatcher: buildDispatcher(url), failedAt: 0, error: null } : null;
  void previous?.dispatcher.close().catch(() => {});
}

export function configureProxy(url: string | null) {
  apply(url);
  setSetting(PROXY_KEY, url);
}

export function proxyStatus() {
  if (!proxy) return null;
  return { url: labelOf(proxy.url), healthy: proxy.failedAt === 0, error: proxy.error };
}

try {
  apply(getSetting(PROXY_KEY));
} catch (err) {
  console.error("[proxy] saved proxy URL is invalid, using a direct connection:", errorMessage(err));
}

export interface YtRequest {
  method?: string;
  headers?: Record<string, string>;
  redirect?: "follow" | "error";
  timeoutMs: number;
  /** Only for the connectivity probe: it must run while the server believes it is offline. */
  probe?: boolean;
}

/**
 * Every request to YouTube or Google goes through here. With a proxy set, the proxy is tried first; if it fails,
 * the same request is retried directly ("none") and the proxy is skipped for a cool-down so a dead proxy does not
 * slow down every request. A failed direct request is a real error and is thrown.
 */
export async function ytFetch(url: string, { timeoutMs, probe = false, ...init }: YtRequest) {
  if (!probe && !isOnline()) throw new OfflineError(); // fail at once: no request can work, and no timeout has to run out
  const route = proxy && Date.now() - proxy.failedAt >= PROXY_COOLDOWN_MS ? proxy : null;
  if (route) {
    try {
      const res = await fetch(url, { ...init, dispatcher: route.dispatcher, signal: AbortSignal.timeout(Math.min(timeoutMs, PROXY_ATTEMPT_MS)) });
      if (route.failedAt && proxy === route) {
        route.failedAt = 0;
        route.error = null;
        audit("info", "proxy.recovered", `Proxy ${labelOf(route.url)} works again`);
      }
      return res;
    } catch (err) {
      if (proxy === route) {
        route.failedAt = Date.now();
        route.error = errorMessage(err);
        audit("warn", "proxy.fallback", `Proxy ${labelOf(route.url)} failed (${route.error}). Using a direct connection for ${PROXY_COOLDOWN_MS / 1000}s.`);
      }
    }
  }
  try {
    return await fetch(url, { ...init, dispatcher: direct, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (!probe && (isNetworkError(err) || isTimeout(err))) reportNetworkFailure();
    throw err;
  }
}

// Any HTTP answer, even an error status, proves the route works; only a failed request does not.
setProbe(async () => {
  const res = await ytFetch(PROBE_URL, { method: "HEAD", timeoutMs: 3_000, probe: true });
  await res.body?.cancel().catch(() => {});
  return true;
});

// After an outage every pooled socket is suspect: start with fresh connections (and give a failed proxy a new chance).
events.on("network", ({ online }) => {
  if (!online) return;
  const old = direct;
  direct = makeAgent();
  void old.close().catch(() => {});
  if (proxy) apply(proxy.url);
});

// ---------- Shared by every YouTube source ----------

export const REQUEST_TIMEOUT_MS = 5000;

export const PAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+1; SOCS=CAI",
};

export class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`YouTube HTTP ${status}`);
    this.status = status;
  }
}

/** The channel does not exist. Permanent: no other source can change that. */
export class NotFoundError extends Error {}

/** YouTube is asking for a consent click, a sign-in or a bot check. Retrying right away only makes it worse. */
export class BlockedError extends Error {}

/** Throttling: back off for minutes, not seconds. */
export const isThrottle = (err: unknown) => err instanceof BlockedError || (err instanceof HttpError && err.status === 429);

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** The server decided it is offline, so the request was not even tried. */
export class OfflineError extends Error {
  constructor() {
    super("No internet connection");
  }
}

/** A request that ran out of time. Alone it proves nothing: the connectivity probe tells a dead line from a slow server. */
export const isTimeout = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** This machine is offline or DNS is down. That says nothing about whether one YouTube source is healthy. */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof OfflineError) return true;
  const cause: unknown = err instanceof Error ? err.cause : null;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  return NETWORK_CODES.has(code);
}

type Res = Awaited<ReturnType<typeof ytFetch>>;

export async function ensureOk(res: Res) {
  if (res.ok) return;
  await res.body?.cancel().catch(() => {});
  throw new HttpError(res.status);
}

export async function readBounded(res: Res, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of res.body ?? []) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("YouTube response is too large");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

import { socksDispatcher } from "fetch-socks";
import { ProxyAgent, fetch, type Dispatcher } from "undici";
import { audit } from "./audit.ts";
import { errorMessage } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";

const PROXY_KEY = "proxyUrl";
const PROXY_COOLDOWN_MS = 60_000;
const PROXY_ATTEMPT_MS = 6_000;
const DEFAULT_SOCKS_PORT = 1080;

interface Proxy {
  url: string;
  dispatcher: Dispatcher;
  failedAt: number;
  error: string | null;
}

let proxy: Proxy | null = null;

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
}

/**
 * Every request to YouTube or Google goes through here. With a proxy set, the proxy is tried first; if it fails,
 * the same request is retried directly ("none") and the proxy is skipped for a cool-down so a dead proxy does not
 * slow down every request. A failed direct request is a real error and is thrown.
 */
export async function ytFetch(url: string, { timeoutMs, ...init }: YtRequest) {
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
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

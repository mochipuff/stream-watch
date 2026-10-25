export const PORT = Number(process.env.PORT) || 8787;
export const HOST = process.env.HOST || "127.0.0.1";
export const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY?.trim() ?? "";

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

// Imported first by index.ts, so a bad setup stops here before the database is touched.
// There is no login: the only protection is that nothing but this machine can reach the API.
if (!LOOPBACK.includes(HOST)) {
  console.error(`[api] HOST=${HOST} would expose an API without a login to the network. Use 127.0.0.1 (or localhost).`);
  process.exit(1);
}

const ALLOWED_HOSTS = new Set([...LOOPBACK, "[::1]"]);

// Rejects DNS rebinding: a web page on another domain cannot reach this API through a hostname it controls.
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return ALLOWED_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

/** A browser always sends `Origin` on a cross-site POST or a WebSocket upgrade. No header means a local tool such as curl. */
export function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false; // "null" (sandboxed frame, file://) and garbage
  }
}

export interface GuardInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  contentType: string | undefined;
}

/**
 * Replaces the old admin token. Without a secret, any website open in the browser could otherwise fire a request at
 * http://127.0.0.1:8787 (CSRF) or rebind its own DNS name to it. Returns the error to send, or null when the request may pass.
 */
export function guardRequest({ method, host, origin, secFetchSite, contentType }: GuardInput): { status: 403 | 415; error: string } | null {
  if (!hostAllowed(host)) return { status: 403, error: "Forbidden host" };
  if (!originAllowed(origin, host)) return { status: 403, error: "Forbidden origin" };
  if (secFetchSite !== undefined && secFetchSite !== "same-origin" && secFetchSite !== "none") return { status: 403, error: "Cross-site request blocked" };
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  if (hasBody && contentType && !/^application\/json\b/i.test(contentType)) return { status: 415, error: "Content-Type must be application/json" };
  return null;
}

/** Strips secrets from text that is stored in the audit log or shown in the dashboard. */
export function redact(text: string): string {
  let clean = text
    .replace(/(\/webhooks\/\d+\/)[\w-]+/g, "$1***")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/([?&]key=)[^&\s]+/gi, "$1***");
  if (YOUTUBE_API_KEY) clean = clean.split(YOUTUBE_API_KEY).join("***");
  return clean;
}

export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  const cause = err.cause instanceof Error ? err.cause : null;
  const detail = cause ? String((cause as NodeJS.ErrnoException).code ?? cause.message) : "";
  return redact(detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message);
}

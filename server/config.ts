export const PORT = Number(process.env.PORT) || 8787;
export const HOST = process.env.HOST || "127.0.0.1";
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
export const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY?.trim() ?? "";

// Imported first by index.ts, so a bad setup stops here before the database is touched.
if (ADMIN_TOKEN.length < 16) {
  console.error("[api] ADMIN_TOKEN (16+ characters) is missing. Run `npm run dev` once to generate it, or set it in .env.");
  process.exit(1);
}
if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  console.warn(`[api] HOST=${HOST} exposes the API beyond this machine over plain HTTP. Keep 127.0.0.1 unless HTTPS sits in front.`);
}

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", HOST]);

// Rejects DNS rebinding: a web page on another domain cannot reach this API through a hostname it controls.
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return ALLOWED_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
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

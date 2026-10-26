import { SOURCE_NAMES } from "../shared/contract.ts";
import type { SourceName, SourceStateDto } from "../shared/contract.ts";
import { audit } from "./audit.ts";
import { YOUTUBE_API_KEY, errorMessage } from "./config.ts";
import { isSourceEnabled } from "./db.ts";
import { events } from "./events.ts";
import { isNetworkError, isThrottle } from "./http.ts";

export const SOURCE_LABEL: Record<SourceName, string> = { rss: "RSS", scrape: "Page scraping", api: "YouTube API" };

// One flaky answer is normal (YouTube sometimes returns a short-lived 404 or 500 on a feed). Only a run of failures, or an
// explicit throttle (HTTP 429, consent or bot check), pauses a source, and only for a while: 10s, 20s, 40s ... up to 2m.
const TRIP_AFTER = 3;
const BASE_PAUSE_MS = 10_000;
const MAX_PAUSE_MS = 2 * 60_000;
const THROTTLE_PAUSE_MS = 2 * 60_000;

interface Health {
  fails: number; // consecutive, across all channels: YouTube throttles an IP, not a channel
  until: number; // back-off: skipped until then, except by a manual check
  lockedUntil: number; // hard stop (API quota): not even a manual check may go through
  paused: boolean; // a pause has been announced and not yet recovered from
  error: string | null;
}

const health = Object.fromEntries(
  SOURCE_NAMES.map((name) => [name, { fails: 0, until: 0, lockedUntil: 0, paused: false, error: null } satisfies Health]),
) as Record<SourceName, Health>;

export const isConfigured = (name: SourceName) => name !== "api" || YOUTUBE_API_KEY !== "";

/** A manual check (`force`) skips the back-off, but never the on/off switch, a missing key or a quota lock. */
export function canUse(name: SourceName, force = false): boolean {
  if (!isConfigured(name) || !isSourceEnabled(name)) return false;
  const now = Date.now();
  return now >= health[name].lockedUntil && (force || now >= health[name].until);
}

/** The reason a source that is switched on is being skipped right now, for error messages. Null when it is simply off. */
export function pauseNote(name: SourceName): string | null {
  const h = health[name];
  const until = Math.max(h.until, h.lockedUntil);
  if (!isConfigured(name) || !isSourceEnabled(name) || until <= Date.now()) return null;
  return `${SOURCE_LABEL[name]} is paused until ${new Date(until).toLocaleTimeString()}${h.error ? ` (${h.error})` : ""}`;
}

export function succeeded(name: SourceName) {
  const h = health[name];
  if (h.paused) audit("info", "source.recovered", `${SOURCE_LABEL[name]} works again`);
  h.fails = 0;
  h.until = 0;
  h.paused = false;
  h.error = null;
}

export function failed(name: SourceName, err: unknown) {
  if (isNetworkError(err)) return; // offline or DNS down: not this source's fault, nothing to back off from
  const h = health[name];
  h.fails++;
  h.error = errorMessage(err);
  const throttled = isThrottle(err);
  if (!throttled && h.fails < TRIP_AFTER) return;
  const backoff = Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * 2 ** Math.max(0, h.fails - TRIP_AFTER));
  const pause = throttled ? Math.max(backoff, THROTTLE_PAUSE_MS) : backoff;
  h.until = Date.now() + pause;
  if (!h.paused) {
    h.paused = true;
    audit("warn", "source.paused", `${SOURCE_LABEL[name]} paused for ${Math.round(pause / 1000)}s after ${h.fails} failed request(s): ${h.error}`);
  }
}

export function lock(name: SourceName, ms: number, reason: string) {
  health[name].lockedUntil = Date.now() + ms;
  health[name].error = reason;
}

/** Clears the back-off (not a quota lock), e.g. when the person switches a source back on. */
export function reset(name: SourceName) {
  Object.assign(health[name], { fails: 0, until: 0, paused: false, error: null });
}

// An outage (and the timeouts it caused before it was noticed) must not leave a source resting after the connection is back.
events.on("network", () => {
  for (const name of SOURCE_NAMES) reset(name);
});

export function sourceStates(): Record<SourceName, SourceStateDto> {
  const now = Date.now();
  return Object.fromEntries(
    SOURCE_NAMES.map((name) => {
      const until = Math.max(health[name].until, health[name].lockedUntil);
      return [name, { enabled: isSourceEnabled(name), configured: isConfigured(name), pausedUntil: until > now ? until : null, error: health[name].error }];
    }),
  ) as Record<SourceName, SourceStateDto>;
}

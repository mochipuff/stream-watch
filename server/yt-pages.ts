import { z } from "zod";
import { VIDEO_ID_RE } from "../shared/contract.ts";
import { BlockedError, HttpError, NotFoundError, PAGE_HEADERS, REQUEST_TIMEOUT_MS, ensureOk, isThrottle, ytFetch } from "./http.ts";
import type { Stream } from "./youtube.ts";

// Everything that reads youtube.com pages (no RSS, no API key). Two jobs:
//  1. Discovery: which videos of a channel MIGHT be live or upcoming (the /streams tab).
//  2. Classification: what a video IS, read from its own watch page. This is the single authority for what gets announced.

const CHANNEL_PAGE_MAX_CHARS = 3_000_000;
const WATCH_PAGE_MAX_CHARS = 1_500_000;
const LIVE_PAGE_MAX_CHARS = 1_500_000;
const MAX_CANDIDATES = 15;

const nowSec = () => Math.floor(Date.now() / 1000);
const toUnix = (iso: string | undefined | null) => {
  if (!iso) return null;
  const sec = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
};

const PLAYER_MARKER = "ytInitialPlayerResponse = ";
const DATA_MARKERS = ["ytInitialData = ", 'window["ytInitialData"] = ', "window['ytInitialData'] = "] as const;

/**
 * True once the script block that starts at one of the markers has fully arrived, so a page is read only as far as needed.
 * Each chunk is searched only from where the previous one ended; the JSON itself is parsed once, afterwards.
 */
function scriptClosed(markers: readonly string[]): (html: string) => boolean {
  const overlap = Math.max(...markers.map((m) => m.length)) + 8;
  let markerAt = -1;
  let searched = 0;
  return (html) => {
    const from = Math.max(0, searched - overlap);
    searched = html.length;
    if (markerAt === -1) {
      for (const marker of markers) {
        const at = html.indexOf(marker, from);
        if (at !== -1 && (markerAt === -1 || at < markerAt)) markerAt = at;
      }
      if (markerAt === -1) return false;
    }
    return html.indexOf("</script>", Math.max(markerAt, from)) !== -1;
  };
}

async function getHtml(url: string, isDone: (html: string) => boolean, maxChars: number): Promise<string> {
  const res = await ytFetch(url, { headers: PAGE_HEADERS, redirect: "follow", timeoutMs: REQUEST_TIMEOUT_MS });
  await ensureOk(res);
  if (res.url.includes("consent.youtube.com")) {
    await res.body?.cancel().catch(() => {});
    throw new BlockedError("YouTube consent page blocked the request");
  }
  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of res.body ?? []) {
    html += decoder.decode(chunk, { stream: true });
    if (isDone(html) || html.length > maxChars) break;
  }
  return html;
}

function extractJson(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const open = html.indexOf("{", at + marker.length);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractInitialData(html: string): unknown {
  for (const marker of DATA_MARKERS) {
    const data = extractJson(html, marker);
    if (data) return data;
  }
  return null;
}

// ---------- Discovery: the channel's /streams tab ----------
// The tab only suggests which videos might be live or upcoming. Past streams sit in the same list and YouTube's markup changes
// often, so every candidate is confirmed through its watch page before anything is sent.

type Json = Record<string, any>;

function walk(node: unknown, visit: (obj: Json) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  visit(node as Json);
  for (const value of Object.values(node)) walk(value, visit);
}

// Titles and other free text must never decide anything: a title like "ALIVE" or "[LIVE] replay" is not a live badge.
const FREE_TEXT_KEYS = new Set([
  "title",
  "accessibility",
  "accessibilityText",
  "descriptionSnippet",
  "detailedMetadataSnippets",
  "headline",
  "ownerText",
  "longBylineText",
  "shortBylineText",
]);
const LIVE_SIGNAL = /"style":"LIVE"|BADGE_STYLE_TYPE_LIVE_NOW|OVERLAY_BADGE_STYLE_LIVE|"imageName":"LIVE"|"isLive":true|\bwatching\b/;
const UPCOMING_SIGNAL = /upcomingEventData|"style":"UPCOMING"|BADGE_STYLE_UPCOMING|\bScheduled for\b|\bPremieres\b/;

function looksLiveOrUpcoming(renderer: Json): boolean {
  const text = JSON.stringify(renderer, (key, value: unknown) => (FREE_TEXT_KEYS.has(key) ? undefined : value));
  return LIVE_SIGNAL.test(text) || UPCOMING_SIGNAL.test(text);
}

function candidatesFromInitialData(data: unknown): string[] {
  const ids = new Set<string>();
  const found = (id: unknown, renderer: Json | undefined) => {
    if (typeof id === "string" && VIDEO_ID_RE.test(id) && renderer && looksLiveOrUpcoming(renderer)) ids.add(id);
  };
  walk(data, (obj) => {
    found(obj.videoRenderer?.videoId, obj.videoRenderer);
    found(obj.gridVideoRenderer?.videoId, obj.gridVideoRenderer);
    found(obj.lockupViewModel?.contentId, obj.lockupViewModel);
  });
  return [...ids].slice(0, MAX_CANDIDATES);
}

/**
 * Reads a channel page. Returns null when the page is not a channel listing at all (an error page, a changed layout): that must
 * count as a failed read, never as "nothing is live". Candidates come from the open tab only, so sidebars and recommendations
 * cannot add noise; when no tab is marked as open the whole page is used.
 */
function channelListing(data: unknown): { ids: string[]; name: string | null } | null {
  const seen: { tabs: number; open: Json | undefined; name: string | null } = { tabs: 0, open: undefined, name: null };
  walk(data, (obj) => {
    const tab: unknown = obj.tabRenderer;
    if (tab && typeof tab === "object") {
      seen.tabs++;
      const t = tab as Json;
      if (t.selected === true && t.content) seen.open ??= t;
    }
    const title: unknown = obj.channelMetadataRenderer?.title;
    if (seen.name === null && typeof title === "string" && title.trim()) seen.name = title.trim();
  });
  if (seen.tabs === 0) return null;
  return { ids: candidatesFromInitialData(seen.open?.content ?? data), name: seen.name };
}

// Last resort when the page has no readable ytInitialData.
function candidatesFromHtml(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(/"videoId":"([\w-]{11})"[^}]{1,1500}?(?:"upcomingEventData"|"style":"LIVE")/g)) ids.add(match[1]!);
  return [...ids].slice(0, MAX_CANDIDATES);
}

/** `/live` answers with the watch page of the channel's latest stream only while one is running, or with the channel page. Either way the watch page decides. */
async function liveNowId(channelId: string): Promise<string | null> {
  const html = await getHtml(`https://www.youtube.com/channel/${channelId}/live?hl=en`, (h) => h.includes("</head>"), LIVE_PAGE_MAX_CHARS);
  return /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})/.exec(html)?.[1] ?? null;
}

export interface Scraped {
  ids: string[];
  name: string | null;
  /** Only the /live page could be read, so upcoming streams are not covered. Usually a sign that YouTube changed its markup. */
  partial?: true;
}

/**
 * Candidate videos from the channel's own pages. Tries the /streams tab first, then the older live filters, then the handle URL,
 * and finally the /live page. The first page that is really a channel listing wins; a listing with nothing live is a valid answer.
 */
export async function scrapeChannel(handle: string, channelId: string): Promise<Scraped> {
  const byId = `https://www.youtube.com/channel/${channelId}`;
  const urls = [
    `${byId}/streams?hl=en`,
    `${byId}/videos?view=0&sort=dd&live_view=501&hl=en`,
    `${byId}/videos?view=0&sort=dd&live_view=502&hl=en`,
    `https://www.youtube.com/${handle}/streams?hl=en`,
  ];
  let firstError: unknown;
  for (const url of urls) {
    try {
      const html = await getHtml(url, scriptClosed(DATA_MARKERS), CHANNEL_PAGE_MAX_CHARS);
      const data = extractInitialData(html);
      const listing = data ? channelListing(data) : null;
      if (listing) return listing;
      const fallback = candidatesFromHtml(html);
      if (fallback.length > 0) return { ids: fallback, name: null };
      firstError ??= new Error("YouTube page layout changed: the channel listing is not readable");
    } catch (err) {
      firstError ??= err;
      if (isThrottle(err)) break; // the other pages would be refused too
    }
  }
  try {
    const id = await liveNowId(channelId);
    return { ids: id ? [id] : [], name: null, partial: true };
  } catch {
    throw firstError;
  }
}

// ---------- Classification: the watch page ----------

const playerSchema = z.object({
  playabilityStatus: z
    .object({
      status: z.string().optional(),
      reason: z.string().optional(),
      liveStreamability: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  videoDetails: z
    .object({
      videoId: z.string().optional(),
      channelId: z.string().optional(),
      title: z.string().optional(),
      isUpcoming: z.boolean().optional(),
      isLive: z.boolean().optional(),
    })
    .optional(),
  microformat: z
    .object({
      playerMicroformatRenderer: z
        .object({
          liveBroadcastDetails: z
            .object({
              isLiveNow: z.boolean().optional(),
              startTimestamp: z.string().optional(),
              endTimestamp: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

// A page without video details that still gives a final answer: removed, private, members-only, age-gated. Anything else is unreadable.
const FINAL_UNPLAYABLE = new Set(["ERROR", "UNPLAYABLE", "LOGIN_REQUIRED", "AGE_VERIFICATION_REQUIRED", "CONTENT_CHECK_REQUIRED"]);

/** A stream, or null for a plain video. Throws when the page cannot be trusted, so a bad answer is never remembered as "plain". */
function classifyPlayer(html: string, videoId: string): Stream | null {
  const json = extractJson(html, PLAYER_MARKER);
  if (!json || typeof json !== "object") {
    if (html.includes("consent.youtube.com") || html.includes("Sign in to confirm")) {
      throw new BlockedError("YouTube consent or anti-bot verification blocked the request");
    }
    throw new Error("YouTube page layout changed: player data is not readable");
  }
  const parsed = playerSchema.safeParse(json);
  if (!parsed.success) throw new Error("YouTube page layout changed: player data is not readable");

  const { videoDetails: video, microformat, playabilityStatus } = parsed.data;
  if (!video) {
    // The bot check also arrives as a valid player response without video details. Reading it as "plain video" would hide a real stream for 14 days.
    if (/\bbot\b|unusual traffic|captcha/i.test(playabilityStatus?.reason ?? "")) throw new BlockedError("YouTube anti-bot verification blocked the request");
    if (FINAL_UNPLAYABLE.has(playabilityStatus?.status ?? "")) return null;
    throw new Error("YouTube page layout changed: video details are missing");
  }
  if (video.videoId && video.videoId !== videoId) return null;

  const live = microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  // A stream that already ended is a plain video (VOD), whatever else the page says.
  if (live?.endTimestamp) return null;

  const title = video.title || "Untitled stream";
  const startAt = toUnix(live?.startTimestamp);
  const channelId = video.channelId;

  // An explicit `isLiveNow: false` wins over a leftover `isLive` flag.
  if (live?.isLiveNow ?? video.isLive) return { videoId, title, status: "live", startAt, channelId };

  // `isUpcoming` / LIVE_STREAM_OFFLINE are the real signals. The weaker hints (a live-streamability block, a start time)
  // also exist on finished streams, so they only count while the start time is still ahead.
  const scheduled = Boolean(video.isUpcoming) || playabilityStatus?.status === "LIVE_STREAM_OFFLINE";
  const hinted = (Boolean(playabilityStatus?.liveStreamability) || startAt !== null) && (startAt === null || startAt > nowSec());
  if (!scheduled && !hinted) return null;

  let upcomingAt = startAt;
  if (!upcomingAt) {
    const matchStart = /"upcomingEventData":\{"startTime":"(\d+)"/.exec(html);
    if (matchStart) upcomingAt = Number(matchStart[1]);
  }
  return { videoId, title, status: "upcoming", startAt: upcomingAt, channelId };
}

/** Reads each video's watch page, one after the other. A video that could not be read has no entry in `verdicts`. */
export async function classifyByPages(videoIds: readonly string[]): Promise<{ verdicts: Map<string, Stream | null>; failures: unknown[] }> {
  const verdicts = new Map<string, Stream | null>();
  const failures: unknown[] = [];
  for (const id of videoIds) {
    try {
      const html = await getHtml(`https://www.youtube.com/watch?v=${id}&hl=en`, scriptClosed([PLAYER_MARKER]), WATCH_PAGE_MAX_CHARS);
      verdicts.set(id, classifyPlayer(html, id));
    } catch (err) {
      failures.push(err);
      if (isThrottle(err)) break; // every further page would be refused too
    }
  }
  return { verdicts, failures };
}

// ---------- Finding the channel id of a handle ----------

const CHANNEL_ID_PATTERNS = [
  /feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/,
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
  /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
  /\{"key":"browse_id","value":"(UC[\w-]{22})"/,
  /"externalId":"(UC[\w-]{22})"/,
  /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/,
];
const BROWSE_ID_PATTERN = /"browseId":"(UC[\w-]{22})"/;
const CHANNEL_ID_OVERLAP = 128;

function readChannelId(html: string): string | null {
  for (const pattern of CHANNEL_ID_PATTERNS) {
    const id = pattern.exec(html)?.[1];
    if (id) return id;
  }
  return null;
}

function channelIdArrived(): (html: string) => boolean {
  let scanned = 0;
  return (html) => {
    const from = Math.max(0, scanned - CHANNEL_ID_OVERLAP);
    scanned = html.length;
    return readChannelId(from === 0 ? html : html.slice(from)) !== null;
  };
}

export async function resolveChannelId(handle: string): Promise<string> {
  let html: string;
  try {
    html = await getHtml(`https://www.youtube.com/${handle}`, channelIdArrived(), CHANNEL_PAGE_MAX_CHARS);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new NotFoundError("Channel not found");
    throw err;
  }
  const id = readChannelId(html);
  if (id) return id;
  const about = await getHtml(`https://www.youtube.com/${handle}/about`, channelIdArrived(), CHANNEL_PAGE_MAX_CHARS).catch(() => "");
  const found = readChannelId(about) ?? BROWSE_ID_PATTERN.exec(html)?.[1] ?? BROWSE_ID_PATTERN.exec(about)?.[1];
  if (found) return found;
  const title = /<title>([^<]{1,80})/.exec(html)?.[1]?.trim();
  throw new Error(`Could not read the channel id from YouTube${title ? ` (page title: ${title})` : ""}`);
}

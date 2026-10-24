import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { CHANNEL_ID_RE, VIDEO_ID_RE } from "../shared/contract.ts";
import type { CheckSource, StreamStatus } from "../shared/contract.ts";
import { audit } from "./audit.ts";
import { YOUTUBE_API_KEY, errorMessage } from "./config.ts";
import { query } from "./db.ts";
import { ytFetch } from "./http.ts";

export interface Stream {
  videoId: string;
  title: string;
  status: StreamStatus;
  startAt: number | null; // unix seconds
}

export interface ChannelRef {
  handle: string;
  youtubeId: string | null;
  name: string | null;
}

export interface Lookup {
  channelId: string;
  channelName: string;
  source: CheckSource;
  streams: Stream[];
}

class NotFoundError extends Error {}

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`YouTube HTTP ${status}`);
    this.status = status;
  }
}

class ApiError extends Error {
  reason: string;
  constructor(status: number, reason: string) {
    super(`YouTube API ${status}${reason ? `: ${reason}` : ""}`);
    this.reason = reason;
  }
}

type Res = Awaited<ReturnType<typeof ytFetch>>;

const PAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+1; SOCS=CAI",
};

const REQUEST_TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 512 * 1024;
const MAX_API_BYTES = 256 * 1024;
const MAX_CANDIDATES = 15;
const FEED_RETRY_DELAY_MS = 1500;
const CHANNEL_PAGE_MAX_CHARS = 3_000_000;
const MAX_PAGE_LOOKUPS_PER_CHECK = 5;
const STREAM_TTL_MS = 5 * 60_000;
const PLAIN_TTL_SEC = 14 * 86_400;
const API_PAUSE_MS = 3_600_000;

const nowSec = () => Math.floor(Date.now() / 1000);
const toUnix = (iso: string | undefined | null) => {
  if (!iso) return null;
  const sec = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
};

// Plain videos are cached so we never re-classify normal uploads.
const findPlain = query("SELECT 1 FROM plain_videos WHERE video_id = ?");
const savePlain = query("INSERT OR REPLACE INTO plain_videos (video_id, checked_at) VALUES (?, ?)");
const deletePlain = query("DELETE FROM plain_videos WHERE video_id = ?");
query("DELETE FROM plain_videos WHERE checked_at < ?").run(nowSec() - PLAIN_TTL_SEC);

const streamMemo = new Map<string, { stream: Stream; until: number }>();

function remember(videoId: string, stream: Stream | null) {
  if (!stream) {
    streamMemo.delete(videoId);
    savePlain.run(videoId, nowSec());
    return;
  }
  // Unblock in case it was previously misclassified as a plain video
  deletePlain.run(videoId);
  if (streamMemo.size >= 200) streamMemo.delete(streamMemo.keys().next().value!);
  streamMemo.set(videoId, { stream, until: Date.now() + STREAM_TTL_MS });
}

function cached(videoId: string): { known: true; stream: Stream | null } | { known: false } {
  if (findPlain.get(videoId)) return { known: true, stream: null };
  const memo = streamMemo.get(videoId);
  return memo && memo.until > Date.now() ? { known: true, stream: memo.stream } : { known: false };
}

async function ensureOk(res: Res) {
  if (res.ok) return;
  await res.body?.cancel().catch(() => {});
  throw new HttpError(res.status);
}

async function readBounded(res: Res, maxBytes: number): Promise<string> {
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

async function getHtml(url: string, isDone: (html: string) => boolean, maxChars = 4_000_000): Promise<string> {
  const res = await ytFetch(url, { headers: PAGE_HEADERS, redirect: "follow", timeoutMs: REQUEST_TIMEOUT_MS });
  await ensureOk(res);
  if (res.url.includes("consent.youtube.com")) {
    await res.body?.cancel().catch(() => {});
    throw new Error("YouTube consent page blocked the request");
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
  return (
    extractJson(html, "ytInitialData = ") ??
    extractJson(html, 'window["ytInitialData"] = ') ??
    extractJson(html, "window['ytInitialData'] = ")
  );
}

// ---------- Tab /streams scraper (discovery only) ----------
// The tab only suggests which videos MIGHT be live or upcoming. Past streams sit in the same list and YouTube's markup
// changes often, so every candidate is confirmed through its watch page (`classifyByPages`) before anything is sent.

type Json = Record<string, any>;

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
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Json;
    found(obj.videoRenderer?.videoId, obj.videoRenderer);
    found(obj.gridVideoRenderer?.videoId, obj.gridVideoRenderer);
    found(obj.lockupViewModel?.contentId, obj.lockupViewModel);
    for (const value of Object.values(obj)) walk(value);
  };
  walk(data);
  return [...ids].slice(0, MAX_CANDIDATES);
}

// Last resort when the page has no readable ytInitialData.
function candidatesFromHtml(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(/"videoId":"([\w-]{11})"[^}]{1,1500}?(?:"upcomingEventData"|"style":"LIVE")/g)) ids.add(match[1]!);
  return [...ids].slice(0, MAX_CANDIDATES);
}

async function fetchTabCandidates(handleOrChannelId: string): Promise<string[]> {
  const base = CHANNEL_ID_RE.test(handleOrChannelId)
    ? `https://www.youtube.com/channel/${handleOrChannelId}`
    : `https://www.youtube.com/${handleOrChannelId.startsWith("@") ? handleOrChannelId : `@${handleOrChannelId}`}`;
  // Listing pages only. `/live` is deliberately absent: it answers with the watch page of the channel's latest
  // stream, even when that stream ended long ago.
  const urls = [`${base}/streams`, `${base}/videos?view=0&sort=dd&live_view=501`, `${base}/videos?view=0&sort=dd&live_view=502`];

  let lastError: unknown;
  for (const url of urls) {
    try {
      const html = await getHtml(url, (h) => extractInitialData(h) !== null, CHANNEL_PAGE_MAX_CHARS);
      const data = extractInitialData(html);
      // A listing that loaded and shows nothing live or upcoming is a valid answer: the other tabs are not requested.
      if (data) return candidatesFromInitialData(data);
      const fallback = candidatesFromHtml(html);
      if (fallback.length > 0) return fallback;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return [];
}

// ---------- Source 1: RSS Feed & Watch Page Classification ----------

const PLAYER_MARKER = "ytInitialPlayerResponse = ";

const playerSchema = z.object({
  playabilityStatus: z
    .object({
      status: z.string().optional(),
      liveStreamability: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  videoDetails: z
    .object({
      videoId: z.string().optional(),
      title: z.string().optional(),
      isUpcoming: z.boolean().optional(),
      isLive: z.boolean().optional(),
      isLiveContent: z.boolean().optional(),
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

function classifyPlayer(html: string, videoId: string): Stream | null {
  const json = extractJson(html, PLAYER_MARKER);
  if (!json || typeof json !== "object") {
    if (html.includes("consent.youtube.com") || html.includes("Sign in to confirm")) {
      throw new Error("YouTube consent or anti-bot verification blocked the request");
    }
    throw new Error("YouTube page layout changed: player data is not readable");
  }
  const parsed = playerSchema.safeParse(json);
  if (!parsed.success) throw new Error("YouTube page layout changed: player data is not readable");

  const { videoDetails: video, microformat, playabilityStatus } = parsed.data;
  if (video?.videoId && video.videoId !== videoId) return null;

  const live = microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  // A stream that already ended is a plain video (VOD), whatever else the page says.
  if (live?.endTimestamp) return null;

  const title = video?.title || "Untitled stream";
  const startAt = toUnix(live?.startTimestamp);

  // An explicit `isLiveNow: false` wins over a leftover `isLive` flag.
  if (live?.isLiveNow ?? video?.isLive) return { videoId, title, status: "live", startAt };

  // `isUpcoming` / LIVE_STREAM_OFFLINE are the real signals. The weaker hints (a live-streamability block, a start time)
  // also exist on finished streams, so they only count while the start time is still ahead.
  const scheduled = Boolean(video?.isUpcoming) || playabilityStatus?.status === "LIVE_STREAM_OFFLINE";
  const hinted = (Boolean(playabilityStatus?.liveStreamability) || startAt !== null) && (startAt === null || startAt > nowSec());
  if (!scheduled && !hinted) return null;

  let upcomingAt = startAt;
  if (!upcomingAt) {
    const matchStart = /"upcomingEventData":\{"startTime":"(\d+)"/.exec(html);
    if (matchStart) upcomingAt = Number(matchStart[1]);
  }
  return { videoId, title, status: "upcoming", startAt: upcomingAt };
}

async function classifyByPages(videoIds: string[]): Promise<Stream[]> {
  const streams: Stream[] = [];
  const errors: unknown[] = [];
  let lookups = 0;
  for (const id of videoIds) {
    const hit = cached(id);
    if (hit.known) {
      if (hit.stream) streams.push(hit.stream);
      continue;
    }
    if (lookups === MAX_PAGE_LOOKUPS_PER_CHECK) break;
    lookups++;
    try {
      const stream = classifyPlayer(
        await getHtml(`https://www.youtube.com/watch?v=${id}`, (h) => extractJson(h, PLAYER_MARKER) !== null, 1_500_000),
        id,
      );
      remember(id, stream);
      if (stream) streams.push(stream);
    } catch (err) {
      errors.push(err);
    }
  }
  if (lookups > 0 && errors.length === lookups) throw errors[0];
  return streams;
}

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

async function resolveChannelId(handle: string): Promise<string> {
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

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? whole;
  });

async function fetchFeed(param: string): Promise<{ channelName: string | null; videoIds: string[] }> {
  const res = await ytFetch(`https://www.youtube.com/feeds/videos.xml?${param}`, {
    headers: { "user-agent": PAGE_HEADERS["user-agent"] },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  await ensureOk(res);
  const xml = await readBounded(res, MAX_FEED_BYTES);
  if (!xml.includes("<feed")) throw new Error("YouTube feed was not readable");
  return {
    channelName: decodeXml(/<author>\s*<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? "").trim() || null,
    videoIds: [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]!).slice(0, MAX_CANDIDATES),
  };
}

const isTransient = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status >= 500);

async function readFeed(channelId: string): Promise<{ channelName: string | null; videoIds: string[] }> {
  const channelFeed = `channel_id=${channelId}`;
  try {
    return await fetchFeed(channelFeed);
  } catch (first) {
    if (!isTransient(first)) throw first;
    await sleep(FEED_RETRY_DELAY_MS);
    try {
      return await fetchFeed(channelFeed);
    } catch (second) {
      if (!isTransient(second)) throw second;
      return await fetchFeed(`playlist_id=UULV${channelId.slice(2)}`).catch(() => {
        throw second;
      });
    }
  }
}

async function viaRss(channel: ChannelRef): Promise<Lookup> {
  const channelId = channel.youtubeId ?? (await resolveChannelId(channel.handle));

  // 1. Discovery: the /streams tab is the only source that shows far-future scheduled broadcasts that are not in the
  //    recent uploads feed yet. It only nominates candidates; it never decides what is live.
  let tabIds: string[] = [];
  try {
    tabIds = await fetchTabCandidates(channel.handle || channelId);
  } catch {
    try {
      tabIds = await fetchTabCandidates(channelId);
    } catch {
      // The RSS feed alone still covers recent uploads
    }
  }

  // 2. Recent uploads & active broadcasts from the RSS feed
  const feed = await readFeed(channelId);

  // 3. The watch page is the single authority: candidates from the tab come first, then the feed.
  const streams = await classifyByPages([...new Set([...tabIds, ...feed.videoIds])]);

  return {
    channelId,
    channelName: feed.channelName ?? channel.name ?? channel.handle,
    source: "rss",
    streams,
  };
}

// ---------- Source 2: YouTube Data API v3 (Fallback with Search & Videos API) ----------

const API_BASE = "https://www.googleapis.com/youtube/v3";
let apiPausedUntil = 0;

const channelsSchema = z.object({
  items: z.array(z.object({ id: z.string().regex(CHANNEL_ID_RE), snippet: z.object({ title: z.string() }) })).default([]),
});
const searchSchema = z.object({
  items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }) })).default([]),
});
const uploadsSchema = z.object({ items: z.array(z.object({ contentDetails: z.object({ videoId: z.string() }) })).default([]) });
const videosSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({ title: z.string(), liveBroadcastContent: z.string() }),
        liveStreamingDetails: z.object({ scheduledStartTime: z.string().optional(), actualStartTime: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

function apiReason(body: string): string {
  try {
    const parsed = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).min(1) }) }).safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.error.errors[0]!.reason : "";
  } catch {
    return "";
  }
}

async function apiGet<S extends z.ZodType>(path: string, params: Record<string, string>, schema: S): Promise<z.output<S>> {
  if (Date.now() < apiPausedUntil) throw new Error("YouTube API quota is used up, API checks are paused");
  const res = await ytFetch(`${API_BASE}/${path}?${new URLSearchParams(params)}`, {
    headers: { "x-goog-api-key": YOUTUBE_API_KEY },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const body = await readBounded(res, MAX_API_BYTES);
  if (!res.ok) {
    const reason = apiReason(body);
    if (/quota|dailyLimit|rateLimit/i.test(reason)) {
      apiPausedUntil = Date.now() + API_PAUSE_MS;
      audit("warn", "api.quota", "YouTube API quota is used up. API checks are paused for 1 hour.");
    }
    throw new ApiError(res.status, reason);
  }
  const parsed = schema.safeParse(JSON.parse(body));
  if (!parsed.success) throw new Error("YouTube API sent an unexpected response");
  return parsed.data;
}

async function resolveByApi(handle: string): Promise<{ id: string; name: string }> {
  const { items } = await apiGet("channels", { part: "snippet", forHandle: handle }, channelsSchema);
  const channel = items[0];
  if (!channel) throw new NotFoundError("Channel not found");
  return { id: channel.id, name: channel.snippet.title };
}

async function recentUploads(channelId: string): Promise<string[]> {
  try {
    const { items } = await apiGet(
      "playlistItems",
      { part: "contentDetails", playlistId: `UU${channelId.slice(2)}`, maxResults: String(MAX_CANDIDATES) },
      uploadsSchema,
    );
    return items.map((item) => item.contentDetails.videoId);
  } catch (err) {
    if (err instanceof ApiError && err.reason === "playlistNotFound") return [];
    throw err;
  }
}

async function apiUpcomingAndLive(channelId: string): Promise<string[]> {
  const ids = new Set<string>();

  // 1. Search for upcoming scheduled live streams. Keep a wider search window than the RSS feed so a stream
  //    scheduled a year out still gets picked up when it is first public.
  try {
    const upcoming = await apiGet(
      "search",
      { part: "id", channelId, eventType: "upcoming", type: "video", maxResults: "25" },
      searchSchema,
    );
    for (const item of upcoming.items) {
      if (item.id.videoId) ids.add(item.id.videoId);
    }
  } catch {
    // Continue if search is unavailable
  }

  // 2. Search for active live streams
  try {
    const live = await apiGet(
      "search",
      { part: "id", channelId, eventType: "live", type: "video", maxResults: "10" },
      searchSchema,
    );
    for (const item of live.items) {
      if (item.id.videoId) ids.add(item.id.videoId);
    }
  } catch {
    // Continue if search is unavailable
  }

  // 3. Uploads playlist
  const uploads = await recentUploads(channelId);
  for (const id of uploads) ids.add(id);

  return [...ids];
}

async function classifyByApi(videoIds: string[]): Promise<Stream[]> {
  const streams: Stream[] = [];
  const unknown: string[] = [];
  for (const id of videoIds) {
    const hit = cached(id);
    if (!hit.known) unknown.push(id);
    else if (hit.stream) streams.push(hit.stream);
  }
  if (unknown.length === 0) return streams;
  const { items } = await apiGet("videos", { part: "snippet,liveStreamingDetails", id: unknown.join(",") }, videosSchema);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const id of unknown) {
    const item = byId.get(id);
    const status = item?.snippet.liveBroadcastContent;
    if (!item || (status !== "live" && status !== "upcoming")) {
      remember(id, null);
      continue;
    }
    const details = item.liveStreamingDetails;
    const stream: Stream = {
      videoId: id,
      title: item.snippet.title || "Untitled stream",
      status,
      startAt: toUnix(status === "live" ? (details?.actualStartTime ?? details?.scheduledStartTime) : (details?.scheduledStartTime ?? details?.actualStartTime)),
    };
    remember(id, stream);
    streams.push(stream);
  }
  return streams;
}

async function viaApi(channel: ChannelRef): Promise<Lookup> {
  const identity = channel.youtubeId ? { id: channel.youtubeId, name: channel.name ?? channel.handle } : await resolveByApi(channel.handle);
  const videoIds = await apiUpcomingAndLive(identity.id);
  return {
    channelId: identity.id,
    channelName: identity.name,
    source: "api",
    streams: await classifyByApi(videoIds),
  };
}

export async function lookupStreams(channel: ChannelRef): Promise<Lookup> {
  try {
    return await viaRss(channel);
  } catch (rssError) {
    if (!YOUTUBE_API_KEY || rssError instanceof NotFoundError) throw rssError;
    try {
      return await viaApi(channel);
    } catch (apiError) {
      throw new Error(`RSS: ${errorMessage(rssError)}. API: ${errorMessage(apiError)}`);
    }
  }
}

const thumbnails = new Map<string, string>();

export async function thumbnailFor(videoId: string): Promise<string> {
  const cachedUrl = thumbnails.get(videoId);
  if (cachedUrl) return cachedUrl;
  const max = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  try {
    const res = await ytFetch(max, { method: "HEAD", redirect: "error", timeoutMs: 4000 });
    if (res.ok || res.status === 404) {
      const url = res.ok ? max : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      if (thumbnails.size >= 200) thumbnails.delete(thumbnails.keys().next().value!);
      thumbnails.set(videoId, url);
      return url;
    }
  } catch {
    // Network hiccup: not cached, the next send probes again.
  }
  return max;
}

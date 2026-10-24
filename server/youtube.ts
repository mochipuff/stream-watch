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

// ---------- Tab /streams Scraper (Primary Discovery for Upcoming & Live) ----------

function extractStreamsFromInitialData(data: unknown): Stream[] {
  const streams: Stream[] = [];
  const seen = new Set<string>();

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;

    // Handle traditional videoRenderer / gridVideoRenderer
    const v = (obj.videoRenderer ?? obj.gridVideoRenderer) as Record<string, any> | undefined;
    if (v && typeof v.videoId === "string" && VIDEO_ID_RE.test(v.videoId)) {
      const vid = v.videoId;
      if (!seen.has(vid)) {
        const title =
          v.title?.runs?.[0]?.text ??
          v.title?.simpleText ??
          "Untitled stream";

        const upcomingData = v.upcomingEventData as { startTime?: string } | undefined;
        const badgesStr = JSON.stringify(v.badges ?? []);
        const overlaysStr = JSON.stringify(v.thumbnailOverlays ?? []);

        const isUpcoming =
          Boolean(upcomingData?.startTime) ||
          badgesStr.includes("UPCOMING") ||
          overlaysStr.includes("UPCOMING");

        const isLive =
          !isUpcoming &&
          (badgesStr.includes("LIVE") || overlaysStr.includes("LIVE"));

        if (isUpcoming) {
          seen.add(vid);
          const startAt = upcomingData?.startTime ? Number(upcomingData.startTime) : null;
          streams.push({
            videoId: vid,
            title,
            status: "upcoming",
            startAt: Number.isFinite(startAt) && (startAt ?? 0) > 0 ? startAt : null,
          });
        } else if (isLive) {
          seen.add(vid);
          streams.push({ videoId: vid, title, status: "live", startAt: null });
        }
      }
    }

    // Handle lockupViewModel
    const lockup = obj.lockupViewModel as Record<string, any> | undefined;
    if (lockup && typeof lockup.contentId === "string" && VIDEO_ID_RE.test(lockup.contentId)) {
      const vid = lockup.contentId;
      if (!seen.has(vid)) {
        const lockupStr = JSON.stringify(lockup);
        const isUpcoming = lockupStr.includes("UPCOMING") || lockupStr.includes("upcomingEventData");
        const isLive = !isUpcoming && lockupStr.includes("LIVE");
        if (isUpcoming || isLive) {
          seen.add(vid);
          const title =
            lockup.metadata?.lockupMetadataViewModel?.title?.content ??
            "Untitled stream";
          const matchTime = /"startTime":"(\d+)"/.exec(lockupStr);
          const startAt = matchTime ? Number(matchTime[1]) : null;
          streams.push({
            videoId: vid,
            title,
            status: isUpcoming ? "upcoming" : "live",
            startAt: isUpcoming && Number.isFinite(startAt) && (startAt ?? 0) > 0 ? startAt : null,
          });
        }
      }
    }

    for (const val of Object.values(obj)) {
      walk(val);
    }
  }

  walk(data);
  return streams;
}

function extractStreamsFromHtml(html: string): Stream[] {
  const streams: Stream[] = [];
  const seen = new Set<string>();

  const upcomingRe = /"videoId":"([\w-]{11})"[^}]+?"upcomingEventData":\{"startTime":"(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = upcomingRe.exec(html)) !== null) {
    const videoId = match[1]!;
    const startTime = Number(match[2]);
    if (!seen.has(videoId) && VIDEO_ID_RE.test(videoId)) {
      seen.add(videoId);
      streams.push({
        videoId,
        title: "Upcoming stream",
        status: "upcoming",
        startAt: Number.isFinite(startTime) && startTime > 0 ? startTime : null,
      });
    }
  }

  const liveRe = /"videoId":"([\w-]{11})"[^}]+?"style":"LIVE"/g;
  while ((match = liveRe.exec(html)) !== null) {
    const videoId = match[1]!;
    if (!seen.has(videoId) && VIDEO_ID_RE.test(videoId)) {
      seen.add(videoId);
      streams.push({ videoId, title: "Live stream", status: "live", startAt: null });
    }
  }

  return streams;
}

async function fetchStreamsFromTab(handleOrChannelId: string): Promise<Stream[]> {
  const url =
    handleOrChannelId.startsWith("UC") && handleOrChannelId.length === 24
      ? `https://www.youtube.com/channel/${handleOrChannelId}/streams`
      : `https://www.youtube.com/${handleOrChannelId.startsWith("@") ? handleOrChannelId : "@" + handleOrChannelId}/streams`;

  const html = await getHtml(url, (h) => extractInitialData(h) !== null, 3_000_000);
  const data = extractInitialData(html);
  if (data) {
    const streams = extractStreamsFromInitialData(data);
    if (streams.length > 0) return streams;
  }
  return extractStreamsFromHtml(html);
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
  // If the stream already ended, it's not live or upcoming
  if (live?.endTimestamp) return null;

  const title = video?.title || "Untitled stream";

  // Check if live now
  if (live?.isLiveNow || video?.isLive) {
    return {
      videoId,
      title,
      status: "live",
      startAt: toUnix(live?.startTimestamp),
    };
  }

  // Check if upcoming
  const isUpcoming =
    Boolean(video?.isUpcoming) ||
    playabilityStatus?.status === "LIVE_STREAM_OFFLINE" ||
    Boolean(playabilityStatus?.liveStreamability) ||
    Boolean(live?.startTimestamp && !live.isLiveNow);

  if (isUpcoming) {
    let startAt = toUnix(live?.startTimestamp);
    if (!startAt) {
      const matchStart = /"upcomingEventData":\{"startTime":"(\d+)"/.exec(html);
      if (matchStart) startAt = Number(matchStart[1]);
    }
    return { videoId, title, status: "upcoming", startAt };
  }

  return null;
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

  // 1. Fetch upcoming & live streams from the /streams tab
  let tabStreams: Stream[] = [];
  try {
    tabStreams = await fetchStreamsFromTab(channel.handle || channelId);
  } catch {
    if (channelId) {
      try {
        tabStreams = await fetchStreamsFromTab(channelId);
      } catch {
        // Fall back to RSS feed
      }
    }
  }

  for (const s of tabStreams) {
    remember(s.videoId, s);
  }

  // 2. Fetch recent uploads & active broadcasts from RSS feed
  const feed = await readFeed(channelId);

  // 3. Classify any videoIds from feed that were not seen in /streams tab
  const tabIds = new Set(tabStreams.map((s) => s.videoId));
  const remainingIds = feed.videoIds.filter((id) => !tabIds.has(id));
  const pageStreams = await classifyByPages(remainingIds);

  const allStreams: Stream[] = [...tabStreams];
  for (const s of pageStreams) {
    if (!tabIds.has(s.videoId)) {
      allStreams.push(s);
    }
  }

  return {
    channelId,
    channelName: feed.channelName ?? channel.name ?? channel.handle,
    source: "rss",
    streams: allStreams,
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

  // 1. Search for upcoming scheduled live streams
  try {
    const upcoming = await apiGet(
      "search",
      { part: "id", channelId, eventType: "upcoming", type: "video", maxResults: "10" },
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
      { part: "id", channelId, eventType: "live", type: "video", maxResults: "5" },
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
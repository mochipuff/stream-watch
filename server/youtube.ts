import type { CheckSource, ContentKind, SourceName } from "../shared/contract.ts";
import { audit } from "./audit.ts";
import { errorMessage } from "./config.ts";
import { query } from "./db.ts";
import { HttpError, NotFoundError, PAGE_HEADERS, REQUEST_TIMEOUT_MS, ensureOk, isThrottle, readBounded, ytFetch } from "./http.ts";
import { SOURCE_LABEL, canUse, failed, pauseNote, succeeded } from "./sources.ts";
import { classifyByApi, discoverByApi, resolveByApi } from "./yt-api.ts";
import { classifyByPages, resolveChannelId, scrapeChannel } from "./yt-pages.ts";
import type { Scraped } from "./yt-pages.ts";

export interface Stream {
  videoId: string;
  title: string;
  status: ContentKind;
  startAt: number | null; // unix seconds: when a stream starts, or when a VOD or Short was published
  channelId?: string | undefined; // the channel that owns the video, when the source says
}

export interface ChannelRef {
  handle: string;
  youtubeId: string | null;
  name: string | null;
}

export interface LookupOptions {
  force: boolean; // a manual check: skips back-off and the short-lived caches, never an off switch
  manualIds: readonly string[]; // videos added by hand for this channel
}

export interface Lookup {
  channelId: string;
  channelName: string;
  source: CheckSource | null;
  streams: Stream[];
  /** Set when no automatic source answered but the manual videos were still read. The channel shows it as its error. */
  error: string | null;
  /** Manual videos that are finished with: not live or upcoming any more, or owned by another channel. */
  manual: { ended: string[]; foreign: string[] };
}

// How a check works:
//  1. Discovery asks sources for candidate video ids, cheapest first: the RSS feed, then the channel's own pages, and only when
//     both fail the API. Every source has a breaker (sources.ts), so a failing one is skipped for a while instead of being
//     hit on every cycle, and one failing source never fails the check while another answers.
//  2. Classification reads each candidate's watch page (or, if pages cannot be read, the API) and decides live / upcoming / short / vod.
//     null is only for a video nobody can watch (removed, private) or one that belongs to someone else.
//  3. Manual videos are always added to the candidates, so they still work when every automatic source is down.

const MAX_FEED_BYTES = 512 * 1024;
const MAX_CANDIDATES = 15;
const MAX_PAGE_LOOKUPS_PER_CHECK = 5;
const STREAM_TTL_MS = 5 * 60_000;
const PLAIN_TTL_SEC = 14 * 86_400;
// The channel pages are 1 to 3 MB each. They run on a slower clock than the RSS feed (a few KB) unless RSS is down.
const PAGES_TTL_RSS_UP_MS = 2 * 60_000;
const PAGES_TTL_RSS_DOWN_MS = 60_000;
const PARTIAL_WARN_EVERY_MS = 3_600_000;

const nowSec = () => Math.floor(Date.now() / 1000);

// A video that is neither live nor upcoming never changes into one, so it is read once. The row also keeps what a Short or VOD
// announcement needs (title, publish time, owner), so a restart does not read the page again.
const findPlain = query<{ kind: ContentKind | null; title: string | null; published_at: number | null; channel_id: string | null }>(
  "SELECT kind, title, published_at, channel_id FROM plain_videos WHERE video_id = ?",
);
const savePlain = query(
  "INSERT OR REPLACE INTO plain_videos (video_id, checked_at, kind, title, published_at, channel_id) VALUES (?, ?, ?, ?, ?, ?)",
);
const deletePlain = query("DELETE FROM plain_videos WHERE video_id = ?");
query("DELETE FROM plain_videos WHERE checked_at < ?").run(nowSec() - PLAIN_TTL_SEC);

const streamMemo = new Map<string, { stream: Stream; until: number }>();

function remember(videoId: string, stream: Stream | null) {
  if (!stream || stream.status === "vod" || stream.status === "short") {
    streamMemo.delete(videoId);
    savePlain.run(videoId, nowSec(), stream?.status ?? null, stream?.title ?? null, stream?.startAt ?? null, stream?.channelId ?? null);
    return;
  }
  // Unblock in case it was previously misclassified as a plain video
  deletePlain.run(videoId);
  if (streamMemo.size >= 200) streamMemo.delete(streamMemo.keys().next().value!);
  streamMemo.set(videoId, { stream, until: Date.now() + STREAM_TTL_MS });
}

function cached(videoId: string): { known: true; stream: Stream | null } | { known: false } {
  const plain = findPlain.get(videoId);
  if (plain) {
    const { kind, title } = plain;
    // A row from before VODs and Shorts were announced has no kind: it stays a video that is never announced.
    const stream: Stream | null =
      kind && title ? { videoId, title, status: kind, startAt: plain.published_at, channelId: plain.channel_id ?? undefined } : null;
    return { known: true, stream };
  }
  const memo = streamMemo.get(videoId);
  return memo && memo.until > Date.now() ? { known: true, stream: memo.stream } : { known: false };
}

/** Drops what is known about a video, so the next check reads it again. Used when a video is added by hand. */
export function forgetVideo(videoId: string) {
  streamMemo.delete(videoId);
  deletePlain.run(videoId);
}

// ---------- Source: RSS feed ----------

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

// One attempt, no sleeping and retrying: the breaker and the next cycle are the retry. The channel's live-streams playlist
// is a different resource and often answers while the channel feed gives a 404 or 500.
async function readFeed(channelId: string): Promise<{ channelName: string | null; videoIds: string[] }> {
  try {
    return await fetchFeed(`channel_id=${channelId}`);
  } catch (first) {
    if (!isTransient(first)) throw first;
    return await fetchFeed(`playlist_id=UULV${channelId.slice(2)}`).catch(() => {
      throw first;
    });
  }
}

// ---------- Discovery ----------

interface Discovery {
  ids: string[];
  name: string | null;
  answered: SourceName[]; // in order of preference; the first one labels the channel
  errors: Map<SourceName, unknown>; // sources that were tried and failed
  paused: SourceName[]; // sources that are switched on but resting after repeated failures
}

const pagesMemo = new Map<string, { scraped: Scraped; at: number }>();
let lastPartialWarn = 0;

function warnPartial(handle: string) {
  if (Date.now() - lastPartialWarn < PARTIAL_WARN_EVERY_MS) return;
  lastPartialWarn = Date.now();
  audit("warn", "scrape.partial", `The channel page of ${handle} could not be read, only the "live now" check worked. YouTube may have changed its layout.`);
}

async function discover(handle: string, channelId: string, force: boolean): Promise<Discovery> {
  const out: Discovery = { ids: [], name: null, answered: [], errors: new Map(), paused: [] };

  if (canUse("rss", force)) {
    try {
      const feed = await readFeed(channelId);
      out.ids.push(...feed.videoIds);
      out.name = feed.channelName;
      out.answered.push("rss");
      succeeded("rss");
    } catch (err) {
      failed("rss", err);
      out.errors.set("rss", err);
    }
  } else if (pauseNote("rss")) out.paused.push("rss");

  if (canUse("scrape", force)) {
    const memo = pagesMemo.get(channelId);
    const ttl = out.answered.includes("rss") ? PAGES_TTL_RSS_UP_MS : PAGES_TTL_RSS_DOWN_MS;
    if (!force && memo && Date.now() - memo.at < ttl) {
      out.ids.push(...memo.scraped.ids);
      out.name ??= memo.scraped.name;
      out.answered.push("scrape");
    } else {
      try {
        const scraped = await scrapeChannel(handle, channelId);
        if (pagesMemo.size >= 600) pagesMemo.delete(pagesMemo.keys().next().value!);
        pagesMemo.set(channelId, { scraped, at: Date.now() });
        if (scraped.partial) warnPartial(handle);
        out.ids.push(...scraped.ids);
        out.name ??= scraped.name;
        out.answered.push("scrape");
        succeeded("scrape");
      } catch (err) {
        failed("scrape", err);
        out.errors.set("scrape", err);
      }
    }
  } else if (pauseNote("scrape")) out.paused.push("scrape");

  // The API is the last resort: it has a daily quota and RSS plus the pages are free.
  if (out.answered.length === 0) {
    if (canUse("api", force)) {
      try {
        out.ids.push(...(await discoverByApi(channelId)));
        out.answered.push("api");
        succeeded("api");
      } catch (err) {
        failed("api", err);
        out.errors.set("api", err);
      }
    } else if (pauseNote("api")) out.paused.push("api");
  }
  return out;
}

function failureMessage({ errors, paused }: Discovery): string {
  return [
    ...[...errors].map(([name, err]) => `${SOURCE_LABEL[name]}: ${errorMessage(err)}`),
    ...paused.map((name) => pauseNote(name)),
  ]
    .filter(Boolean)
    .join(". ");
}

/** Finds the channel id of a handle: the channel page first (free), the API only when the page does not answer. */
async function identify(handle: string): Promise<string> {
  let pageError: unknown;
  try {
    return await resolveChannelId(handle);
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    pageError = err;
  }
  if (!canUse("api")) throw pageError;
  try {
    const id = await resolveByApi(handle);
    succeeded("api");
    return id;
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    failed("api", err);
    throw new Error(`Page scraping: ${errorMessage(pageError)}. ${SOURCE_LABEL.api}: ${errorMessage(err)}`);
  }
}

// ---------- Classification ----------

async function classify(videoIds: readonly string[], force: boolean): Promise<Map<string, Stream | null>> {
  const verdicts = new Map<string, Stream | null>();
  const unknown: string[] = [];
  for (const id of videoIds) {
    const hit = cached(id);
    if (hit.known) verdicts.set(id, hit.stream);
    else unknown.push(id);
  }
  if (unknown.length === 0) return verdicts;

  // Bounded per check: what does not fit waits for the next one.
  const { verdicts: read, failures } = await classifyByPages(unknown.slice(0, MAX_PAGE_LOOKUPS_PER_CHECK));
  for (const [id, verdict] of read) {
    remember(id, verdict);
    verdicts.set(id, verdict);
  }
  if (failures.length === 0) return verdicts;

  const throttle = failures.find(isThrottle);
  if (throttle) failed("scrape", throttle);

  // Pages did not answer: the API classifies up to 50 videos for one unit.
  if (canUse("api", force)) {
    try {
      for (const [id, verdict] of await classifyByApi(unknown.filter((id) => !verdicts.has(id)))) {
        remember(id, verdict);
        verdicts.set(id, verdict);
      }
      succeeded("api");
      return verdicts;
    } catch (err) {
      failed("api", err);
    }
  }
  if (read.size === 0) throw failures[0]; // nothing could be read at all: this is the error to show
  return verdicts; // partly read: the rest is retried on the next check
}

// ---------- Public ----------

export async function lookupStreams(channel: ChannelRef, { force, manualIds }: LookupOptions): Promise<Lookup> {
  const channelId = channel.youtubeId ?? (await identify(channel.handle));
  const found = await discover(channel.handle, channelId, force);

  let error: string | null = null;
  if (found.answered.length === 0 && (found.errors.size > 0 || found.paused.length > 0)) {
    error = failureMessage(found);
    if (manualIds.length === 0) throw new Error(error);
  }

  const candidates = [...new Set([...manualIds, ...found.ids])];
  const verdicts = await classify(candidates, force);

  const streams: Stream[] = [];
  const manual: Lookup["manual"] = { ended: [], foreign: [] };
  for (const id of candidates) {
    const verdict = verdicts.get(id);
    if (verdict === undefined) continue; // could not be read this time
    const byHand = manualIds.includes(id);
    // A video added by hand stays only while it is live or upcoming. Once it is a VOD it is done with, like before.
    if (byHand && (verdict === null || (verdict.status !== "live" && verdict.status !== "upcoming"))) manual.ended.push(id);
    if (verdict === null) continue;
    if (byHand && verdict.channelId && verdict.channelId !== channelId) {
      manual.foreign.push(id); // announcing another channel's video under this handle would mislead
    } else {
      streams.push(verdict);
    }
  }

  return {
    channelId,
    channelName: found.name ?? channel.name ?? channel.handle,
    source: found.answered[0] ?? (manualIds.length > 0 ? "manual" : null),
    streams,
    error,
    manual,
  };
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

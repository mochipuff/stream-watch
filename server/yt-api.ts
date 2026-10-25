import { z } from "zod";
import { CHANNEL_ID_RE } from "../shared/contract.ts";
import { audit } from "./audit.ts";
import { YOUTUBE_API_KEY } from "./config.ts";
import { NotFoundError, REQUEST_TIMEOUT_MS, readBounded, ytFetch } from "./http.ts";
import { lock } from "./sources.ts";
import type { Stream } from "./youtube.ts";

// Last resort, and cheap on purpose. The daily quota is 10,000 units: `playlistItems`, `videos` and `channels` cost 1 each,
// while `search` costs 100. An earlier version called `search` twice per channel per cycle and used the whole quota in minutes.

const API_BASE = "https://www.googleapis.com/youtube/v3";
const MAX_API_BYTES = 256 * 1024;
const MAX_PLAYLIST_ITEMS = 15;
const MAX_IDS_PER_CALL = 50;
const QUOTA_LOCK_MS = 3_600_000;

class ApiError extends Error {
  reason: string;
  constructor(status: number, reason: string) {
    super(`YouTube API ${status}${reason ? `: ${reason}` : ""}`);
    this.reason = reason;
  }
}

const channelsSchema = z.object({
  items: z.array(z.object({ id: z.string().regex(CHANNEL_ID_RE) })).default([]),
});
const playlistSchema = z.object({ items: z.array(z.object({ contentDetails: z.object({ videoId: z.string() }) })).default([]) });
const videosSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({ title: z.string(), channelId: z.string().optional(), liveBroadcastContent: z.string(), publishedAt: z.string().optional() }),
        contentDetails: z.object({ duration: z.string().optional() }).optional(),
        liveStreamingDetails: z.object({ scheduledStartTime: z.string().optional(), actualStartTime: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

const toUnix = (iso: string | undefined) => {
  const sec = iso ? Math.floor(Date.parse(iso) / 1000) : NaN;
  return Number.isFinite(sec) && sec > 0 ? sec : null;
};

// ISO 8601 duration such as PT45S or PT1H2M3S. Null when it cannot be read.
function durationSeconds(iso: string | undefined): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

// The API does not say whether a video is a Short. Up to a minute is the classic definition; anything longer counts as a VOD here.
const API_SHORT_MAX_SECONDS = 60;

function apiReason(body: string): string {
  try {
    const parsed = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).min(1) }) }).safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.error.errors[0]!.reason : "";
  } catch {
    return "";
  }
}

async function apiGet<S extends z.ZodType>(path: string, params: Record<string, string>, schema: S): Promise<z.output<S>> {
  const res = await ytFetch(`${API_BASE}/${path}?${new URLSearchParams(params)}`, {
    headers: { "x-goog-api-key": YOUTUBE_API_KEY }, // in a header, never in a URL that could reach a log
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const body = await readBounded(res, MAX_API_BYTES);
  if (!res.ok) {
    const reason = apiReason(body);
    if (/quota|dailyLimit|rateLimit/i.test(reason)) {
      lock("api", QUOTA_LOCK_MS, "quota is used up");
      audit("warn", "api.quota", "YouTube API quota is used up. API checks are paused for 1 hour.");
    }
    throw new ApiError(res.status, reason);
  }
  const parsed = schema.safeParse(JSON.parse(body));
  if (!parsed.success) throw new Error("YouTube API sent an unexpected response");
  return parsed.data;
}

export async function resolveByApi(handle: string): Promise<string> {
  const { items } = await apiGet("channels", { part: "id", forHandle: handle }, channelsSchema);
  if (!items[0]) throw new NotFoundError("Channel not found");
  return items[0].id;
}

async function playlistVideoIds(playlistId: string): Promise<string[]> {
  try {
    const { items } = await apiGet("playlistItems", { part: "contentDetails", playlistId, maxResults: String(MAX_PLAYLIST_ITEMS) }, playlistSchema);
    return items.map((item) => item.contentDetails.videoId);
  } catch (err) {
    if (err instanceof ApiError && err.reason === "playlistNotFound") return []; // no uploads or no live streams yet
    throw err;
  }
}

/** Two units per channel: the live-streams playlist (UULV) holds live and scheduled broadcasts, the uploads playlist (UU) the rest. */
export async function discoverByApi(channelId: string): Promise<string[]> {
  const suffix = channelId.slice(2);
  const [live, uploads] = await Promise.all([playlistVideoIds(`UULV${suffix}`), playlistVideoIds(`UU${suffix}`)]);
  return [...new Set([...live, ...uploads])];
}

/** One unit per 50 videos. A video missing from the answer (deleted, private) has no verdict worth announcing. */
export async function classifyByApi(videoIds: readonly string[]): Promise<Map<string, Stream | null>> {
  const verdicts = new Map<string, Stream | null>();
  for (let i = 0; i < videoIds.length; i += MAX_IDS_PER_CALL) {
    const chunk = videoIds.slice(i, i + MAX_IDS_PER_CALL);
    const { items } = await apiGet("videos", { part: "snippet,contentDetails,liveStreamingDetails", id: chunk.join(",") }, videosSchema);
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const id of chunk) {
      const item = byId.get(id);
      const status = item?.snippet.liveBroadcastContent;
      if (!item) {
        verdicts.set(id, null); // deleted or private
        continue;
      }
      const details = item.liveStreamingDetails;
      if (status !== "live" && status !== "upcoming") {
        const seconds = durationSeconds(item.contentDetails?.duration);
        verdicts.set(id, {
          videoId: id,
          title: item.snippet.title || "Untitled video",
          status: seconds !== null && seconds <= API_SHORT_MAX_SECONDS && !details ? "short" : "vod",
          startAt: toUnix(item.snippet.publishedAt),
          channelId: item.snippet.channelId,
        });
        continue;
      }
      verdicts.set(id, {
        videoId: id,
        title: item.snippet.title || "Untitled stream",
        status,
        startAt: toUnix(status === "live" ? (details?.actualStartTime ?? details?.scheduledStartTime) : (details?.scheduledStartTime ?? details?.actualStartTime)),
        channelId: item.snippet.channelId,
      });
    }
  }
  return verdicts;
}

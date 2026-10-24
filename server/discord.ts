import { setTimeout as sleep } from "node:timers/promises";
import { WEBHOOK_RE } from "../shared/contract.ts";
import type { StreamStatus } from "../shared/contract.ts";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface PayloadInput {
  channelName: string;
  handle: string | null;
  video: { videoId: string; title: string; status: StreamStatus; startAt: number | null };
  thumbnail: string;
}

// No `username` on purpose: Discord shows the webhook's own default name and avatar.
export function buildPayload({ channelName, handle, video, thumbnail }: PayloadInput) {
  const url = `https://www.youtube.com/watch?v=${video.videoId}`;
  const live = video.status === "live";
  const description = live
    ? "Live now"
    : video.startAt
      ? `Starts <t:${video.startAt}:F> (<t:${video.startAt}:R>)`
      : "Start time not announced yet";
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clip(video.title, 256),
        url,
        description,
        color: 0xd92d4a,
        author: { name: clip(channelName, 256), ...(handle ? { url: `https://www.youtube.com/${handle}` } : {}) },
        image: { url: thumbnail }, // Discord loads it from YouTube's CDN; this server never downloads it
        footer: { text: live ? "Live stream" : "Upcoming stream" },
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Watch on YouTube", url }] }],
  };
}

export async function postWebhook(webhookUrl: string, payload: ReturnType<typeof buildPayload>): Promise<void> {
  // Last line of defence: only ever POST to a real Discord webhook endpoint.
  if (!WEBHOOK_RE.test(webhookUrl)) throw new Error("Invalid Discord webhook URL");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${webhookUrl}?wait=true&with_components=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const { retry_after = 1 } = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(Number(retry_after), 10) * 1000 + 100);
      continue;
    }
    throw new Error(`Discord HTTP ${res.status}`);
  }
  throw new Error("Discord rate limit");
}

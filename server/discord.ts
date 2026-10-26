import { setTimeout as sleep } from "node:timers/promises";
import { fetch } from "undici";
import { WEBHOOK_RE } from "../shared/contract.ts";
import type { ContentKind } from "../shared/contract.ts";
import { directAgent } from "./http.ts";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface PayloadInput {
  channelName: string;
  handle: string | null;
  video: { videoId: string; title: string; status: ContentKind; startAt: number | null };
  thumbnail: string;
  message?: string | null;
  roleIds?: readonly string[];
}

const PLACEHOLDER_RE = /@\{roleid\}|\{user\}/gi;
const ROLE_TOKEN_RE = /@\{roleid\}/i;

/**
 * `{user}` becomes the channel handle and `@{roleid}` becomes a mention of every role saved for that handle.
 * Only the saved roles are allowed to ping (see `allowed_mentions`), so a typed `<@&id>`, `@everyone` or `@here` never pings.
 */
function renderMessage(template: string | null | undefined, handle: string | null, roleIds: readonly string[]) {
  if (!template) return { content: undefined, roles: [] };
  const mentions = roleIds.map((id) => `<@&${id}>`).join(" ");
  const text = template.replace(PLACEHOLDER_RE, (token) => (token.toLowerCase() === "{user}" ? (handle ?? "") : mentions));
  return { content: clip(text.trim(), 2000) || undefined, roles: ROLE_TOKEN_RE.test(template) ? [...roleIds] : [] };
}

const FOOTER: Record<ContentKind, string> = { upcoming: "Upcoming stream", live: "Live stream", vod: "Video", short: "Short" };

function describe({ status, startAt }: PayloadInput["video"]): string | undefined {
  switch (status) {
    case "live":
      return "Live now";
    case "upcoming":
      return startAt ? `Starts <t:${startAt}:F> (<t:${startAt}:R>)` : "Start time not announced yet";
    default:
      return startAt ? `Published <t:${startAt}:R>` : undefined;
  }
}

// No `username` on purpose: Discord shows the webhook's own default name and avatar.
export function buildPayload({ channelName, handle, video, thumbnail, message, roleIds = [] }: PayloadInput) {
  const { content, roles } = renderMessage(message, handle, roleIds);
  const url = `https://www.youtube.com/${video.status === "short" ? "shorts/" : "watch?v="}${video.videoId}`;
  const description = describe(video);
  return {
    ...(content ? { content } : {}),
    allowed_mentions: { parse: [], roles },
    embeds: [
      {
        title: clip(video.title, 256),
        url,
        ...(description ? { description } : {}),
        color: 0xd92d4a,
        author: { name: clip(channelName, 256), ...(handle ? { url: `https://www.youtube.com/${handle}` } : {}) },
        image: { url: thumbnail }, // Discord loads it from YouTube's CDN; this server never downloads it
        footer: { text: FOOTER[video.status] },
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
      dispatcher: directAgent(),
      signal: AbortSignal.timeout(7_000),
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

import { CONTENT_KINDS } from "../shared/contract.ts";
import type { ChannelDto, CheckSource, ContentKind, CycleDto, Overview } from "../shared/contract.ts";
import { getIntervalMs, isAutoEnabled, parseKinds, query } from "./db.ts";
import { isOnline } from "./connectivity.ts";
import { proxyStatus } from "./http.ts";
import { state } from "./poller.ts";
import { sourceStates } from "./sources.ts";

const channelRows = query<{
  id: string;
  handle: string;
  name: string | null;
  enabled: number;
  checked_at: number | null;
  upcoming_count: number | null;
  live_count: number;
  source: CheckSource | null;
  error: string | null;
  kinds: string | null;
}>("SELECT id, handle, name, enabled, checked_at, upcoming_count, live_count, source, error, kinds FROM channels ORDER BY rowid");
const linkRows = query<{ channel_id: string; webhook_id: string }>("SELECT channel_id, webhook_id FROM channel_webhooks");
const manualRows = query<{ channel_id: string; video_id: string; added_at: number }>(
  "SELECT channel_id, video_id, added_at FROM manual_videos ORDER BY added_at",
);
const webhookRows = query<{ id: string; name: string; url: string; enabled: number; error: string | null }>(
  "SELECT id, name, url, enabled, error FROM webhooks ORDER BY rowid",
);
const recentRows = query<{
  webhook_id: string;
  video_id: string;
  title: string;
  start_at: number | null;
  sent_at: number;
  status: ContentKind;
  webhook_name: string | null;
  handle: string | null;
}>(
  `SELECT s.webhook_id, s.video_id, s.title, s.start_at, s.sent_at, s.status, w.name AS webhook_name, c.handle
   FROM sent_streams s
   LEFT JOIN webhooks w ON w.id = s.webhook_id
   LEFT JOIN channels c ON c.id = s.channel_id
   WHERE s.delivered = 1
   ORDER BY s.sent_at DESC LIMIT 25`,
);

const previewOf = (url: string) => {
  const id = /\/webhooks\/(\d+)\//.exec(url)?.[1];
  return id ? `…/webhooks/${id}/••••••••` : "Discord webhook"; // never expose any part of the secret token
};

// `since` stays on the server: the dashboard only needs the switch and the text.
function kindsDto(raw: string | null): ChannelDto["kinds"] {
  const kinds = parseKinds(raw);
  return Object.fromEntries(CONTENT_KINDS.map((kind) => [kind, { enabled: kinds[kind].enabled, message: kinds[kind].message }])) as ChannelDto["kinds"];
}

let rev = 0;

export function cycle(): CycleDto {
  const auto = isAutoEnabled();
  return {
    auto,
    running: state.running,
    intervalMs: getIntervalMs(),
    online: isOnline(),
    lastCycleAt: state.lastCycleAt,
    nextCycleAt: auto ? state.nextCycleAt : null,
  };
}

/** Everything the dashboard shows, built only from fields it needs (never raw rows). */
export function overview(): Overview {
  const links = Object.groupBy(linkRows.all(), (l) => l.channel_id);
  const manual = Object.groupBy(manualRows.all(), (v) => v.channel_id);
  return {
    rev: ++rev,
    cycle: cycle(),
    sources: { sources: sourceStates(), proxy: proxyStatus() },
    channels: channelRows.all().map((c) => ({
      id: c.id,
      handle: c.handle,
      name: c.name,
      enabled: Boolean(c.enabled),
      checkedAt: c.checked_at,
      upcoming: c.upcoming_count ?? 0,
      live: c.live_count,
      source: c.source,
      error: c.error,
      webhookIds: (links[c.id] ?? []).map((l) => l.webhook_id),
      kinds: kindsDto(c.kinds),
      manualVideos: (manual[c.id] ?? []).map((v) => ({ videoId: v.video_id, addedAt: v.added_at })),
    })),
    webhooks: webhookRows.all().map((w) => ({
      id: w.id,
      name: w.name,
      preview: previewOf(w.url),
      enabled: Boolean(w.enabled),
      error: w.error,
    })),
    recent: recentRows.all().map((r) => ({
      webhookId: r.webhook_id,
      videoId: r.video_id,
      title: r.title,
      handle: r.handle || "unknown",
      webhook: r.webhook_name || "deleted-webhook",
      status: r.status,
      canResend: r.webhook_name != null,
      startAt: r.start_at,
      sentAt: r.sent_at,
    })),
  };
}

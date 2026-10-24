import { setTimeout as sleep } from "node:timers/promises";
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, VIDEO_ID_RE } from "../shared/contract.ts";
import type { CheckSource, CheckSummary } from "../shared/contract.ts";
import { audit } from "./audit.ts";
import { errorMessage } from "./config.ts";
import { getIntervalMs, isAutoEnabled, query } from "./db.ts";
import { buildPayload, postWebhook } from "./discord.ts";
import { events } from "./events.ts";
import { lookupStreams, thumbnailFor } from "./youtube.ts";
import type { Stream } from "./youtube.ts";

interface Hook {
  id: string;
  name: string;
  url: string;
  error: string | null;
}
interface Channel {
  id: string;
  handle: string;
  youtube_id: string | null;
  name: string | null;
  source: CheckSource | null;
  error: string | null;
}

export class CheckRejectedError extends Error {
  status: 409 | 429;
  constructor(status: 409 | 429, message: string) {
    super(message);
    this.status = status;
  }
}

export const state: { running: boolean; lastCycleAt: number | null; nextCycleAt: number | null } = {
  running: false,
  lastCycleAt: null,
  nextCycleAt: null,
};

const MAX_PARALLEL_CHANNELS = 3;
const MANUAL_GAP_MS = 5000;
const nowSec = () => Math.floor(Date.now() / 1000);

// Exponential backoff per channel / webhook so a failing target is not hammered every few seconds.
// A manual check ignores it on purpose: the person asked for it.
const penalty = new Map<string, { n: number; until: number }>();
const blocked = (key: string) => (penalty.get(key)?.until ?? 0) > Date.now();
const fail = (key: string) => {
  const n = (penalty.get(key)?.n ?? 0) + 1;
  penalty.set(key, { n, until: Date.now() + Math.min(5000 * 2 ** n, 300_000) });
};
const ok = (key: string) => penalty.delete(key);

export function forget(id: string) {
  penalty.delete(`ch:${id}`);
  penalty.delete(`hook:${id}`);
}

const enabledHooks = query<Hook>("SELECT id, name, url, error FROM webhooks WHERE enabled = 1");
const enabledChannels = query<Channel>("SELECT id, handle, youtube_id, name, source, error FROM channels WHERE enabled = 1 ORDER BY rowid");
const allLinks = query<{ channel_id: string; webhook_id: string }>("SELECT channel_id, webhook_id FROM channel_webhooks");
const handleOf = query<{ handle: string }>("SELECT handle FROM channels WHERE id = ?");

// Claim first, send second: the PRIMARY KEY makes "already sent" atomic even if two sends race.
// A claim stays `delivered = 0` until Discord accepts the message; see `discardUnconfirmed`.
const claim = query(
  `INSERT OR IGNORE INTO sent_streams (webhook_id, video_id, channel_id, title, start_at, sent_at, channel_name, status, delivered)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
);
const confirm = query("UPDATE sent_streams SET delivered = 1 WHERE webhook_id = ? AND video_id = ?");
const release = query("DELETE FROM sent_streams WHERE webhook_id = ? AND video_id = ? AND delivered = 0");
// A crash or restart between claim and confirm would otherwise turn into a notification that is never sent.
const discardUnconfirmed = query("DELETE FROM sent_streams WHERE delivered = 0");
// Keeps the stored snapshot (used by "Send again") current if a stream is renamed, rescheduled or goes live. No network involved.
const refresh = query(
  `UPDATE sent_streams SET title = ?, start_at = ?, channel_name = ?, status = ?
   WHERE webhook_id = ? AND video_id = ? AND (title IS NOT ? OR start_at IS NOT ? OR channel_name IS NOT ? OR status IS NOT ?)`,
);
const setHookError = query("UPDATE webhooks SET error = ? WHERE id = ?");
const markChecked = query(
  `UPDATE channels SET checked_at = ?, youtube_id = ?, name = ?, source = ?, upcoming_count = ?, live_count = ?, error = NULL WHERE id = ?`,
);
const markFailed = query("UPDATE channels SET checked_at = ?, error = ? WHERE id = ?");

async function deliver(hook: Hook, channel: Channel, channelName: string, stream: Stream, force: boolean): Promise<boolean> {
  const key = `hook:${hook.id}`;
  if (!force && blocked(key)) return false;
  const sentAt = nowSec();
  const claimed =
    Number(claim.run(hook.id, stream.videoId, channel.id, stream.title, stream.startAt, sentAt, channelName, stream.status).changes) === 1;
  if (!claimed) {
    refresh.run(stream.title, stream.startAt, channelName, stream.status, hook.id, stream.videoId, stream.title, stream.startAt, channelName, stream.status);
    return false;
  }
  try {
    const thumbnail = await thumbnailFor(stream.videoId);
    await postWebhook(hook.url, buildPayload({ channelName, handle: channel.handle, video: stream, thumbnail }));
  } catch (err) {
    release.run(hook.id, stream.videoId); // failed send must be retried later
    fail(key);
    const message = errorMessage(err);
    if (hook.error !== message) {
      hook.error = message;
      setHookError.run(message, hook.id);
      audit("error", "webhook.error", `${hook.name}: ${message}`);
    }
    return false;
  }
  confirm.run(hook.id, stream.videoId);
  ok(key);
  if (hook.error) {
    hook.error = null;
    setHookError.run(null, hook.id);
    audit("info", "webhook.recovered", `${hook.name} is working again`);
  }
  audit("info", "stream.sent", `"${stream.title}" (${channel.handle}) sent to ${hook.name}${stream.status === "live" ? " while live" : ""}`);
  events.emit("stream_sent", {
    title: stream.title,
    videoId: stream.videoId,
    handle: channel.handle,
    webhookName: hook.name,
    startAt: stream.startAt,
    sentAt,
  });
  events.emit("changed"); // "Recently sent" updates now, not when the whole cycle ends
  return true;
}

async function checkChannel(channel: Channel, hooks: Hook[], force: boolean): Promise<{ sent: number; failed: boolean }> {
  const key = `ch:${channel.id}`;
  if (!force && blocked(key)) return { sent: 0, failed: false };
  try {
    const found = await lookupStreams({ handle: channel.handle, youtubeId: channel.youtube_id, name: channel.name });
    const streams = found.streams.filter((s) => VIDEO_ID_RE.test(s.videoId));
    ok(key);
    markChecked.run(
      nowSec(),
      found.channelId,
      found.channelName,
      found.source,
      streams.filter((s) => s.status === "upcoming").length,
      streams.filter((s) => s.status === "live").length,
      channel.id,
    );
    if (channel.error) audit("info", "channel.recovered", `${channel.handle} is working again`);
    if (channel.source && channel.source !== found.source) {
      audit(found.source === "api" ? "warn" : "info", "channel.source", `${channel.handle} is now checked through ${found.source === "api" ? "the YouTube API (RSS failed)" : "RSS"}`);
    }
    let sent = 0;
    for (const stream of streams) {
      for (const hook of hooks) if (await deliver(hook, channel, found.channelName, stream, force)) sent++;
    }
    return { sent, failed: false };
  } catch (err) {
    fail(key);
    const message = errorMessage(err);
    markFailed.run(nowSec(), message, channel.id);
    // Only announce a new problem, not the same one on every retry.
    if (channel.error !== message) {
      events.emit("channel_error", { channelId: channel.id, handle: channel.handle, error: message });
      audit("error", "channel.error", `${channel.handle}: ${message}`);
    }
    return { sent: 0, failed: true };
  }
}

interface Scope {
  channelId?: string;
  manual: boolean;
}

// The first statement runs synchronously, so `state.running` is set before any caller can start a second run.
async function run({ channelId, manual }: Scope): Promise<CheckSummary> {
  state.running = true;
  events.emit("changed");
  try {
    const hooks = enabledHooks.all();
    const hookById = new Map(hooks.map((h) => [h.id, h]));
    const linksByChannel = Object.groupBy(allLinks.all(), (l) => l.channel_id);
    const work = enabledChannels.all().flatMap((channel) => {
      if (channelId && channel.id !== channelId) return [];
      const channelHooks = (linksByChannel[channel.id] ?? []).flatMap((l) => hookById.get(l.webhook_id) ?? []);
      // The automatic cycle skips a channel nobody is subscribed to, so it costs no YouTube request.
      return manual || channelHooks.length > 0 ? [{ channel, hooks: channelHooks }] : [];
    });
    const summary: CheckSummary = { channels: work.length, sent: 0, failed: 0 };
    // Bounded concurrency: many channels must not become a burst of simultaneous YouTube requests.
    let next = 0;
    const worker = async () => {
      while (next < work.length) {
        const item = work[next++]!;
        const result = await checkChannel(item.channel, item.hooks, manual);
        summary.sent += result.sent;
        if (result.failed) summary.failed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHANNELS, work.length) }, worker));
    return summary;
  } finally {
    state.running = false;
    if (!channelId) state.lastCycleAt = Date.now();
    events.emit("changed");
  }
}

let lastManualAt = 0;

/**
 * Starts a check now, independent of the automatic cycle (which may be switched off), and returns at once.
 * Omit `channelId` to check every enabled channel. The result goes to the audit log and a `check_done` event.
 */
export function startCheck(channelId?: string): void {
  if (state.running) throw new CheckRejectedError(409, "A check is already running");
  const wait = lastManualAt + MANUAL_GAP_MS - Date.now();
  if (wait > 0) throw new CheckRejectedError(429, `Wait ${Math.ceil(wait / 1000)}s before checking again`);
  lastManualAt = Date.now();
  void run({ channelId, manual: true }).then(
    (summary) => {
      const target = channelId ? (handleOf.get(channelId)?.handle ?? "channel") : `${summary.channels} channels`;
      audit(
        summary.failed ? "warn" : "info",
        "check.manual",
        `Manual check of ${target}: ${summary.sent} sent${summary.failed ? `, ${summary.failed} failed` : ""}`,
      );
      events.emit("check_done", { ...summary, target });
    },
    (err) => audit("error", "check.manual", `Manual check failed: ${errorMessage(err)}`),
  );
}

let stopped = false;
let wake = new AbortController();

// Ends the current sleep early so a changed interval or a switched auto mode applies now, not after the old (maybe hour-long) sleep.
export function reschedule() {
  wake.abort();
  wake = new AbortController();
}

export function stopPoller() {
  stopped = true;
  wake.abort();
}

async function nap(ms: number) {
  try {
    await sleep(ms, undefined, { signal: wake.signal });
  } catch {
    // woken early: the callers re-read the settings and the clock
  }
}

function setNext(at: number | null) {
  if (state.nextCycleAt === at) return;
  state.nextCycleAt = at;
  events.emit("changed");
}

async function sleepUntilDue(started: number) {
  const jitter = Math.random() * 500;
  while (!stopped && isAutoEnabled()) {
    const due = started + getIntervalMs();
    setNext(due);
    const left = due + jitter - Date.now();
    if (left <= 0) return;
    await nap(left);
  }
}

export function startPoller() {
  discardUnconfirmed.run();
  void (async () => {
    while (!stopped) {
      if (!isAutoEnabled()) {
        setNext(null);
        await nap(MAX_INTERVAL_MS);
        continue;
      }
      const started = Date.now();
      try {
        if (!state.running) await run({ manual: false }); // a manual check that is already running covers this tick
        await sleepUntilDue(started);
      } catch (err) {
        console.error("[poller] cycle failed:", errorMessage(err));
        await nap(MIN_INTERVAL_MS);
      }
    }
  })();
}

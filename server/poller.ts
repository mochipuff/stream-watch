import { setTimeout as sleep } from "node:timers/promises";
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, VIDEO_ID_RE } from "../shared/contract.ts";
import type { CheckSource, CheckSummary } from "../shared/contract.ts";
import { audit } from "./audit.ts";
import { errorMessage } from "./config.ts";
import { isOnline, reportNetworkFailure, waitUntilOnline } from "./connectivity.ts";
import { getIntervalMs, isAutoEnabled, parseKinds, query } from "./db.ts";
import type { KindSettings } from "./db.ts";
import { buildPayload, postWebhook } from "./discord.ts";
import { events } from "./events.ts";
import { OfflineError, isNetworkError, isTimeout } from "./http.ts";
import { SOURCE_LABEL } from "./sources.ts";
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
  kinds: string | null;
}

export class CheckRejectedError extends Error {
  status: 409 | 429 | 503;
  constructor(status: 409 | 429 | 503, message: string) {
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
const MANUAL_TTL_SEC = 14 * 86_400; // a video added by hand that never goes live stops being checked after two weeks
const MANUAL_GAP_MS = 5000;
const MAX_BACKOFF_MS = 30_000; // a channel is never skipped for long: a stream can start any second
const nowSec = () => Math.floor(Date.now() / 1000);

// Exponential backoff per channel / webhook so a failing target is not hammered every few seconds.
// A manual check ignores it on purpose: the person asked for it.
const penalty = new Map<string, { n: number; until: number }>();
const blocked = (key: string) => (penalty.get(key)?.until ?? 0) > Date.now();
const fail = (key: string) => {
  const n = (penalty.get(key)?.n ?? 0) + 1;
  penalty.set(key, { n, until: Date.now() + Math.min(2000 * 2 ** n, MAX_BACKOFF_MS) });
};
const ok = (key: string) => penalty.delete(key);

export function forget(id: string) {
  penalty.delete(`ch:${id}`);
  penalty.delete(`hook:${id}`);
}

const enabledHooks = query<Hook>("SELECT id, name, url, error FROM webhooks WHERE enabled = 1");
const enabledChannels = query<Channel>("SELECT id, handle, youtube_id, name, source, error, kinds FROM channels WHERE enabled = 1 ORDER BY rowid");
const allLinks = query<{ channel_id: string; webhook_id: string }>("SELECT channel_id, webhook_id FROM channel_webhooks");
const handleOf = query<{ handle: string }>("SELECT handle FROM channels WHERE id = ?");
const manualOf = query<{ video_id: string }>("SELECT video_id FROM manual_videos WHERE channel_id = ? ORDER BY added_at");
const removeManual = query("DELETE FROM manual_videos WHERE channel_id = ? AND video_id = ?");
const expireManual = query("DELETE FROM manual_videos WHERE added_at < ?");

// Claim first, send second: the PRIMARY KEY makes "already sent" atomic even if two sends race.
// A claim stays `delivered = 0` until Discord accepts the message; see `discardUnconfirmed`.
const claim = query(
  `INSERT OR IGNORE INTO sent_streams (webhook_id, video_id, channel_id, title, start_at, sent_at, channel_name, status, delivered)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
);
// A stream announced as upcoming gets one more message when it goes live (the Live message of the channel). Same atomic idea as the
// claim: only one caller can turn the `upcoming` row into an unconfirmed `live` one. A failed send turns it back.
const promote = query("UPDATE sent_streams SET status = 'live', delivered = 0 WHERE webhook_id = ? AND video_id = ? AND status = 'upcoming' AND delivered = 1");
const demote = query("UPDATE sent_streams SET status = 'upcoming', delivered = 1 WHERE webhook_id = ? AND video_id = ? AND status = 'live' AND delivered = 0");
const confirm = query(
  "UPDATE sent_streams SET delivered = 1, sent_at = ?, title = ?, start_at = ?, channel_name = ?, status = ? WHERE webhook_id = ? AND video_id = ?",
);
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
  `UPDATE channels SET checked_at = ?, youtube_id = ?, name = ?, source = ?, upcoming_count = ?, live_count = ?, error = ? WHERE id = ?`,
);
const markFailed = query("UPDATE channels SET checked_at = ?, error = ? WHERE id = ?");

const isStream = (stream: Stream) => stream.status === "live" || stream.status === "upcoming";

/** Whether a stream or video is announced for this channel. A VOD or Short must be newer than the moment its kind was switched on. */
function wanted(stream: Stream, kinds: KindSettings): boolean {
  const kind = kinds[stream.status];
  if (!kind.enabled) return false;
  return isStream(stream) || (kind.since > 0 && stream.startAt !== null && stream.startAt >= kind.since);
}

type Outcome = "sent" | "already" | "failed";

async function deliver(hook: Hook, channel: Channel, kinds: KindSettings, channelName: string, stream: Stream, force: boolean): Promise<Outcome> {
  const key = `hook:${hook.id}`;
  if (!isOnline() || (!force && blocked(key))) return "failed";
  const sentAt = nowSec();
  let claimed =
    Number(claim.run(hook.id, stream.videoId, channel.id, stream.title, stream.startAt, sentAt, channelName, stream.status).changes) === 1;
  let promoted = false;
  if (!claimed && stream.status === "live") {
    promoted = Number(promote.run(hook.id, stream.videoId).changes) === 1;
    claimed = promoted;
  }
  if (!claimed) {
    // Only a stream changes (new title, new start time). A VOD or Short is final, and a stream that has become a VOD keeps what it was announced as.
    if (isStream(stream)) refresh.run(stream.title, stream.startAt, channelName, stream.status, hook.id, stream.videoId, stream.title, stream.startAt, channelName, stream.status);
    return "already";
  }
  try {
    const thumbnail = await thumbnailFor(stream.videoId);
    await postWebhook(
      hook.url,
      buildPayload({ channelName, handle: channel.handle, video: stream, thumbnail, message: kinds[stream.status].message }),
    );
  } catch (err) {
    if (promoted) demote.run(hook.id, stream.videoId);
    else release.run(hook.id, stream.videoId); // failed send must be retried later
    // A dead connection says nothing about the webhook: no back-off, no error on it. The next cycle retries.
    const lineDown = isNetworkError(err);
    if (lineDown || isTimeout(err)) reportNetworkFailure();
    if (!lineDown) {
      fail(key);
      const message = errorMessage(err);
      if (hook.error !== message) {
        hook.error = message;
        setHookError.run(message, hook.id);
        audit("error", "webhook.error", `${hook.name}: ${message}`);
      }
    }
    return "failed";
  }
  confirm.run(sentAt, stream.title, stream.startAt, channelName, stream.status, hook.id, stream.videoId);
  ok(key);
  if (hook.error) {
    hook.error = null;
    setHookError.run(null, hook.id);
    audit("info", "webhook.recovered", `${hook.name} is working again`);
  }
  audit("info", "stream.sent", `"${stream.title}" (${channel.handle}) sent to ${hook.name} (${stream.status})`);
  events.emit("stream_sent", {
    title: stream.title,
    videoId: stream.videoId,
    handle: channel.handle,
    webhookName: hook.name,
    startAt: stream.startAt,
    sentAt,
  });
  events.emit("changed"); // "Recently sent" updates now, not when the whole cycle ends
  return "sent";
}

// A change of source is only worth a line when it means a worse (API) or manual-only answer, or the return from one:
// RSS and page scraping trade places all the time while YouTube is flaky, and that is what the source breakers are for.
const isFallback = (source: CheckSource | null) => source === "api" || source === "manual";
const labelOf = (source: CheckSource) => (source === "manual" ? "the manual videos only" : SOURCE_LABEL[source]);

type Tally = Omit<CheckSummary, "channels" | "failed"> & { failed: number };
const emptyTally = (): Tally => ({ sent: 0, failed: 0, already: 0, disabled: 0, unlinked: 0 });

async function checkChannel(channel: Channel, hooks: Hook[], force: boolean): Promise<Tally> {
  const key = `ch:${channel.id}`;
  const tally = emptyTally();
  if (!isOnline() || (!force && blocked(key))) return tally;
  try {
    const manualIds = manualOf.all(channel.id).map((row) => row.video_id);
    const found = await lookupStreams({ handle: channel.handle, youtubeId: channel.youtube_id, name: channel.name }, { force, manualIds });
    const streams = found.streams.filter((s) => VIDEO_ID_RE.test(s.videoId));
    markChecked.run(
      nowSec(),
      found.channelId,
      found.channelName,
      found.source,
      streams.filter((s) => s.status === "upcoming").length,
      streams.filter((s) => s.status === "live").length,
      found.error,
      channel.id,
    );
    for (const id of found.manual.ended) {
      removeManual.run(channel.id, id);
      audit("info", "video.finished", `Manual video ${id} of ${channel.handle} is not live or upcoming (any more) and was removed`);
    }
    for (const id of found.manual.foreign) {
      removeManual.run(channel.id, id);
      audit("warn", "video.foreign", `Manual video ${id} belongs to another channel than ${channel.handle} and was removed`);
    }

    if (!isOnline()) return tally; // the line dropped during this check: that is not the channel's error
    if (found.error) {
      fail(key);
      if (channel.error !== found.error) {
        events.emit("channel_error", { channelId: channel.id, handle: channel.handle, error: found.error });
        audit("error", "channel.error", `${channel.handle}: ${found.error}`);
      }
    } else {
      ok(key);
      if (channel.error) audit("info", "channel.recovered", `${channel.handle} is working again`);
    }
    if (channel.source !== found.source && (isFallback(found.source) || isFallback(channel.source))) {
      audit(
        found.source === "api" ? "warn" : "info",
        "channel.source",
        `${channel.handle} is now checked through ${found.source ? labelOf(found.source) : "no source"}`,
      );
    }

    const kinds = parseKinds(channel.kinds);
    for (const stream of streams) {
      if (!wanted(stream, kinds)) {
        if (isStream(stream)) tally.disabled++;
        continue;
      }
      if (hooks.length === 0 && isStream(stream)) tally.unlinked++;
      for (const hook of hooks) {
        const outcome = await deliver(hook, channel, kinds, found.channelName, stream, force);
        if (outcome === "sent") tally.sent++;
        else if (outcome === "failed") tally.failed++;
        else if (isStream(stream)) tally.already++;
      }
    }
    if (found.error !== null) tally.failed++;
    return tally;
  } catch (err) {
    if (err instanceof OfflineError || !isOnline()) return tally;
    fail(key);
    const message = errorMessage(err);
    markFailed.run(nowSec(), message, channel.id);
    // Only announce a new problem, not the same one on every retry.
    if (channel.error !== message) {
      events.emit("channel_error", { channelId: channel.id, handle: channel.handle, error: message });
      audit("error", "channel.error", `${channel.handle}: ${message}`);
    }
    tally.failed++;
    return tally;
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
    expireManual.run(nowSec() - MANUAL_TTL_SEC);
    const hooks = enabledHooks.all();
    const hookById = new Map(hooks.map((h) => [h.id, h]));
    const linksByChannel = Object.groupBy(allLinks.all(), (l) => l.channel_id);
    const work = enabledChannels.all().flatMap((channel) => {
      if (channelId && channel.id !== channelId) return [];
      const channelHooks = (linksByChannel[channel.id] ?? []).flatMap((l) => hookById.get(l.webhook_id) ?? []);
      // The automatic cycle skips a channel nobody is subscribed to, so it costs no YouTube request.
      return manual || channelHooks.length > 0 ? [{ channel, hooks: channelHooks }] : [];
    });
    const summary: CheckSummary = { channels: work.length, sent: 0, failed: 0, already: 0, disabled: 0, unlinked: 0 };
    // Bounded concurrency: many channels must not become a burst of simultaneous YouTube requests.
    let next = 0;
    const worker = async () => {
      while (next < work.length) {
        const item = work[next++]!;
        const result = await checkChannel(item.channel, item.hooks, manual);
        for (const field of ["sent", "failed", "already", "disabled", "unlinked"] as const) summary[field] += result[field];
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

/** "1 sent, 1 already sent before": a check that sends nothing says why. */
export function describe({ sent, failed, already, disabled, unlinked }: CheckSummary): string {
  const notes = [
    failed && `${failed} failed`,
    already && `${already} already sent before`,
    disabled && `${disabled} switched off for the channel`,
    unlinked && `${unlinked} on a channel without webhook`,
  ].filter(Boolean);
  return `${sent} sent${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

let lastManualAt = 0;

/**
 * Starts a check now, independent of the automatic cycle (which may be switched off), and returns at once.
 * Omit `channelId` to check every enabled channel. The result goes to the audit log and a `check_done` event.
 */
export function startCheck(channelId?: string): void {
  if (state.running) throw new CheckRejectedError(409, "A check is already running");
  if (!isOnline()) throw new CheckRejectedError(503, "No internet connection. Checks start again by themselves when it is back.");
  const wait = lastManualAt + MANUAL_GAP_MS - Date.now();
  if (wait > 0) throw new CheckRejectedError(429, `Wait ${Math.ceil(wait / 1000)}s before checking again`);
  lastManualAt = Date.now();
  void run({ channelId, manual: true }).then(
    (summary) => {
      const target = channelId ? (handleOf.get(channelId)?.handle ?? "channel") : `${summary.channels} channels`;
      audit(summary.failed ? "warn" : "info", "check.manual", `Manual check of ${target}: ${describe(summary)}`);
      events.emit("check_done", { ...summary, target });
    },
    (err) => audit("error", "check.manual", `Manual check failed: ${errorMessage(err)}`),
  );
}

// Penalties earned during an outage (or just before it was noticed) are not the channel's fault: start clean on both edges.
events.on("network", () => penalty.clear());

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
      if (!isOnline()) {
        setNext(null);
        await waitUntilOnline(wake.signal); // the first cycle after the outage starts the moment the connection is stable
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

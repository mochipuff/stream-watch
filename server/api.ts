import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { CONTENT_KINDS, KIND_LABEL, MAX_CHANNELS, MAX_MANUAL_VIDEOS, SOURCE_NAMES, VIDEO_ID_RE, schemas, uuid } from "../shared/contract.ts";
import type { ContentKind } from "../shared/contract.ts";
import { audit, readAudit } from "./audit.ts";
import { errorMessage, guardRequest } from "./config.ts";
import { parseKinds, parseRoleIds, query, setSetting, tx } from "./db.ts";
import type { KindSettings } from "./db.ts";
import { buildPayload, postWebhook } from "./discord.ts";
import { events } from "./events.ts";
import { configureProxy, proxyStatus } from "./http.ts";
import { cycle, overview } from "./overview.ts";
import { CheckRejectedError, forget, reschedule, startCheck } from "./poller.ts";
import { SOURCE_LABEL, reset as resetSource } from "./sources.ts";
import { forgetVideo, thumbnailFor } from "./youtube.ts";

const HttpError = (status: ContentfulStatusCode, message: string) => new HTTPException(status, { message });

export const app = new Hono();

// There is no login. The API listens on 127.0.0.1 only (config.ts refuses anything else), and every request must come from
// this machine's own dashboard: a website open in the browser cannot reach it, even by rebinding its DNS name.
app.use("*", async (c, next) => {
  const refused = guardRequest({
    method: c.req.method,
    host: c.req.header("host"),
    origin: c.req.header("origin"),
    secFetchSite: c.req.header("sec-fetch-site"),
    contentType: c.req.header("content-type"),
  });
  if (refused) return c.json({ error: refused.error }, refused.status);
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  await next();
});

// `npm run dev` polls it to know the API is up. Reveals nothing.
app.get("/api/health", (c) => c.json({ ok: true }));

app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Payload too large" }, 413) }));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error("[api]", err);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const raw: unknown = await c.req.json().catch(() => {
    throw HttpError(400, "Body must be valid JSON");
  });
  const result = schema.safeParse(raw);
  if (!result.success) throw HttpError(400, result.error.issues[0]?.message ?? "Invalid request");
  return result.data;
}

function paramId(c: Context, name = "id"): string {
  const parsed = uuid.safeParse(c.req.param(name));
  if (!parsed.success) throw HttpError(404, "Not found");
  return parsed.data;
}

// Every change answers with the fresh snapshot, so the dashboard updates from the response itself and never refetches.
function changed(c: Context, status: 200 | 201 | 202 = 200) {
  events.emit("changed"); // other open tabs get the same snapshot over the WebSocket
  return c.json(overview(), status);
}

const channelCount = query<{ n: number }>("SELECT COUNT(*) AS n FROM channels");
const channelRow = query<{ handle: string; enabled: number; kinds: string | null }>("SELECT handle, enabled, kinds FROM channels WHERE id = ?");
const handleTaken = query("SELECT 1 FROM channels WHERE handle = ? COLLATE NOCASE");
const insertChannel = query("INSERT INTO channels (id, handle) VALUES (?, ?)");
const setChannelEnabled = query("UPDATE channels SET enabled = ? WHERE id = ?");
const setChannelKinds = query("UPDATE channels SET kinds = ? WHERE id = ?");
const setChannelRoles = query("UPDATE channels SET role_ids = ? WHERE id = ?");
const deleteChannel = query("DELETE FROM channels WHERE id = ?"); // links go with it (ON DELETE CASCADE)
const manualCount = query<{ n: number }>("SELECT COUNT(*) AS n FROM manual_videos WHERE channel_id = ?");
const insertManual = query("INSERT OR IGNORE INTO manual_videos (channel_id, video_id, added_at) VALUES (?, ?, ?)");
const deleteManual = query("DELETE FROM manual_videos WHERE channel_id = ? AND video_id = ?");
const clearLinks = query("DELETE FROM channel_webhooks WHERE channel_id = ?");
const insertLink = query("INSERT OR IGNORE INTO channel_webhooks (channel_id, webhook_id) VALUES (?, ?)");

const webhookRow = query<{ name: string; url: string; enabled: number }>("SELECT name, url, enabled FROM webhooks WHERE id = ?");
const urlTaken = query("SELECT 1 FROM webhooks WHERE url = ?");
const insertWebhook = query("INSERT INTO webhooks (id, name, url) VALUES (?, ?, ?)");
const setWebhookEnabled = query("UPDATE webhooks SET enabled = ? WHERE id = ?");
const setWebhookName = query("UPDATE webhooks SET name = ? WHERE id = ?");
const deleteWebhook = query("DELETE FROM webhooks WHERE id = ?");

const resendRow = query<{
  title: string;
  start_at: number | null;
  channel_name: string | null;
  status: ContentKind;
  url: string;
  webhook_name: string;
  handle: string | null;
  kinds: string | null;
  role_ids: string | null;
}>(
  `SELECT s.title, s.start_at, s.channel_name, s.status, w.url, w.name AS webhook_name, c.handle, c.kinds, c.role_ids
   FROM sent_streams s
   JOIN webhooks w ON w.id = s.webhook_id
   LEFT JOIN channels c ON c.id = s.channel_id
   WHERE s.webhook_id = ? AND s.video_id = ? AND s.delivered = 1`,
);
const touchSent = query("UPDATE sent_streams SET sent_at = ? WHERE webhook_id = ? AND video_id = ?");

type KindsPatch = NonNullable<z.output<typeof schemas.channelPatch>["kinds"]>;

/** Applies a patch to the stored settings. Switching a kind on stamps `since`, so only what is published from then on is announced. */
function mergeKinds(current: KindSettings, patch: KindsPatch, nowSec: number): KindSettings {
  const next = structuredClone(current);
  for (const kind of CONTENT_KINDS) {
    const change = patch[kind];
    if (!change) continue;
    if (change.enabled !== undefined) {
      if (change.enabled && !next[kind].enabled) next[kind].since = nowSec;
      next[kind].enabled = change.enabled;
    }
    if (change.message !== undefined) next[kind].message = change.message;
  }
  return next;
}

function setLinks(channelId: string, webhookIds: string[]) {
  clearLinks.run(channelId);
  try {
    for (const id of webhookIds) insertLink.run(channelId, id);
  } catch {
    throw HttpError(400, "Unknown webhook selected"); // foreign key failed; the surrounding tx rolls back
  }
}

app.get("/api/overview", (c) => c.json(overview()));
app.get("/api/cycle", (c) => c.json(cycle()));

app.get("/api/audit", (c) => {
  const parsed = schemas.auditQuery.safeParse(c.req.query());
  if (!parsed.success) throw HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request");
  return c.json(readAudit(parsed.data));
});

// Starts a check and answers at once; a large channel list must not hold the request open. The result arrives
// as a WebSocket event and in the audit log, and GET /api/cycle shows `running` meanwhile.
function runCheck(c: Context, channelId?: string) {
  try {
    startCheck(channelId);
  } catch (err) {
    if (err instanceof CheckRejectedError) throw HttpError(err.status, err.message);
    throw err;
  }
  return c.json(overview(), 202);
}

app.post("/api/check", (c) => runCheck(c));

app.post("/api/channels", async (c) => {
  const body = await parseBody(c, schemas.channelCreate);
  const id = crypto.randomUUID();
  tx(() => {
    if ((channelCount.get()?.n ?? 0) >= MAX_CHANNELS) throw HttpError(409, `Channel limit reached (${MAX_CHANNELS})`);
    if (handleTaken.get(body.handle)) throw HttpError(409, "Channel already exists");
    insertChannel.run(id, body.handle);
    setLinks(id, body.webhookIds);
  });
  audit("info", "channel.added", `Added ${body.handle}`);
  return changed(c, 201);
});

app.patch("/api/channels/:id", async (c) => {
  const id = paramId(c);
  const body = await parseBody(c, schemas.channelPatch);
  const row = tx(() => {
    const current = channelRow.get(id);
    if (!current) throw HttpError(404, "Channel not found");
    if (body.enabled !== undefined) setChannelEnabled.run(body.enabled ? 1 : 0, id);
    if (body.webhookIds) setLinks(id, body.webhookIds);
    if (body.kinds) setChannelKinds.run(JSON.stringify(mergeKinds(parseKinds(current.kinds), body.kinds, Math.floor(Date.now() / 1000))), id);
    if (body.roleIds) setChannelRoles.run(body.roleIds.join(","), id);
    return current;
  });
  if (body.enabled !== undefined && body.enabled !== Boolean(row.enabled)) {
    audit("info", body.enabled ? "channel.resumed" : "channel.paused", `${body.enabled ? "Resumed" : "Paused"} ${row.handle}`);
  }
  if (body.webhookIds) audit("info", "channel.webhooks", `${row.handle} now sends to ${body.webhookIds.length} webhook(s)`);
  if (body.kinds) {
    const names = CONTENT_KINDS.filter((kind) => body.kinds?.[kind]).map((kind) => KIND_LABEL[kind]);
    audit("info", "channel.message", `Updated the ${names.join(", ")} settings of ${row.handle}`);
  }
  if (body.roleIds) audit("info", "channel.roles", `Updated the mentioned roles of ${row.handle}`);
  return changed(c);
});

app.post("/api/channels/:id/check", (c) => {
  const id = paramId(c);
  const row = channelRow.get(id);
  if (!row) throw HttpError(404, "Channel not found");
  if (!row.enabled) throw HttpError(409, "Channel is paused");
  return runCheck(c, id);
});

// A video added by hand is checked together with its channel, so it still works while RSS, page scraping and the API all fail.
app.post("/api/channels/:id/videos", async (c) => {
  const id = paramId(c);
  const { url: videoId } = await parseBody(c, schemas.manualVideoCreate);
  const row = tx(() => {
    const current = channelRow.get(id);
    if (!current) throw HttpError(404, "Channel not found");
    if ((manualCount.get(id)?.n ?? 0) >= MAX_MANUAL_VIDEOS) throw HttpError(409, `At most ${MAX_MANUAL_VIDEOS} videos per channel`);
    insertManual.run(id, videoId, Math.floor(Date.now() / 1000));
    return current;
  });
  forgetVideo(videoId); // read it afresh, even if an earlier check had filed it as a plain video
  audit("info", "video.added", `Added video ${videoId} to ${row.handle}`);
  return changed(c, 201);
});

app.delete("/api/channels/:id/videos/:videoId", (c) => {
  const id = paramId(c);
  const videoId = c.req.param("videoId");
  if (!VIDEO_ID_RE.test(videoId) || Number(deleteManual.run(id, videoId).changes) === 0) throw HttpError(404, "Video not found");
  audit("info", "video.removed", `Removed video ${videoId} from ${channelRow.get(id)?.handle ?? "a channel"}`);
  return changed(c);
});

app.delete("/api/channels/:id", (c) => {
  const id = paramId(c);
  const row = channelRow.get(id);
  if (!row || Number(deleteChannel.run(id).changes) === 0) throw HttpError(404, "Channel not found");
  forget(id);
  audit("info", "channel.removed", `Removed ${row.handle}`);
  return changed(c);
});

app.post("/api/webhooks", async (c) => {
  const body = await parseBody(c, schemas.webhookCreate);
  if (urlTaken.get(body.url)) throw HttpError(409, "Webhook already added");
  insertWebhook.run(crypto.randomUUID(), body.name, body.url);
  audit("info", "webhook.added", `Added webhook ${body.name}`);
  return changed(c, 201);
});

app.patch("/api/webhooks/:id", async (c) => {
  const id = paramId(c);
  const body = await parseBody(c, schemas.webhookPatch);
  const row = tx(() => {
    const current = webhookRow.get(id);
    if (!current) throw HttpError(404, "Webhook not found");
    if (body.enabled !== undefined) setWebhookEnabled.run(body.enabled ? 1 : 0, id);
    if (body.name) setWebhookName.run(body.name, id);
    return current;
  });
  if (body.enabled !== undefined && body.enabled !== Boolean(row.enabled)) {
    audit("info", body.enabled ? "webhook.resumed" : "webhook.paused", `${body.enabled ? "Resumed" : "Paused"} webhook ${row.name}`);
  }
  if (body.name && body.name !== row.name) audit("info", "webhook.renamed", `Renamed webhook ${row.name} to ${body.name}`);
  return changed(c);
});

app.delete("/api/webhooks/:id", (c) => {
  const id = paramId(c);
  const row = webhookRow.get(id);
  if (!row || Number(deleteWebhook.run(id).changes) === 0) throw HttpError(404, "Webhook not found");
  forget(id);
  audit("info", "webhook.removed", `Removed webhook ${row.name}`);
  return changed(c);
});

app.post("/api/webhooks/:id/test", async (c) => {
  const hook = webhookRow.get(paramId(c));
  if (!hook) throw HttpError(404, "Webhook not found");
  const video = { videoId: "dQw4w9WgXcQ", title: "Test Stream Notification", status: "upcoming" as const, startAt: Math.floor(Date.now() / 1000) + 3600 };
  const thumbnail = `https://i.ytimg.com/vi/${video.videoId}/maxresdefault.jpg`;
  try {
    await postWebhook(hook.url, buildPayload({ channelName: "Stream Watch test", handle: "@YouTube", video, thumbnail }));
  } catch (err) {
    audit("warn", "webhook.test", `Test message to ${hook.name} failed: ${errorMessage(err)}`);
    throw HttpError(502, errorMessage(err));
  }
  audit("info", "webhook.test", `Test message sent to ${hook.name}`);
  return c.json(overview());
});

// Manual and deliberately not idempotent, so a short per-target cooldown stops double clicks from spamming Discord.
const RESEND_COOLDOWN_MS = 10_000;
const lastResend = new Map<string, number>();

app.post("/api/sent/:webhookId/:videoId/resend", async (c) => {
  const webhookId = paramId(c, "webhookId");
  const videoId = c.req.param("videoId");
  if (!VIDEO_ID_RE.test(videoId)) throw HttpError(404, "Not found");
  const row = resendRow.get(webhookId, videoId);
  if (!row) throw HttpError(404, "This stream or its webhook no longer exists");

  const now = Date.now();
  for (const [k, at] of lastResend) if (at + RESEND_COOLDOWN_MS < now) lastResend.delete(k);
  const key = `${webhookId}:${videoId}`;
  if (lastResend.has(key)) throw HttpError(429, "Already sent a moment ago, wait a few seconds");
  lastResend.set(key, now);

  try {
    await postWebhook(
      row.url,
      buildPayload({
        channelName: row.channel_name || row.handle || "YouTube channel",
        handle: row.handle,
        video: { videoId, title: row.title, status: row.status, startAt: row.start_at },
        thumbnail: await thumbnailFor(videoId),
        message: parseKinds(row.kinds)[row.status].message,
        roleIds: parseRoleIds(row.role_ids),
      }),
    );
  } catch (err) {
    lastResend.delete(key);
    audit("warn", "stream.resent", `Sending "${row.title}" again to ${row.webhook_name} failed: ${errorMessage(err)}`);
    throw HttpError(502, errorMessage(err));
  }
  touchSent.run(Math.floor(now / 1000), webhookId, videoId);
  audit("info", "stream.resent", `"${row.title}" sent again to ${row.webhook_name}`);
  return changed(c);
});

app.put("/api/settings", async (c) => {
  const body = await parseBody(c, schemas.settings);
  if (body.proxyUrl !== undefined) {
    try {
      configureProxy(body.proxyUrl); // first: an unusable proxy must reject the whole request before anything else is saved
    } catch {
      throw HttpError(400, "Proxy URL cannot be used");
    }
    audit("info", "settings.proxy", body.proxyUrl ? `Proxy set to ${proxyStatus()?.url}` : "Proxy removed, using a direct connection");
  }
  if (body.intervalMs !== undefined) {
    setSetting("intervalMs", String(body.intervalMs));
    audit("info", "settings.interval", `Check interval set to ${body.intervalMs / 1000}s`);
  }
  if (body.sources) {
    for (const name of SOURCE_NAMES) {
      const on = body.sources[name];
      if (on === undefined) continue;
      setSetting(`source.${name}`, on ? "1" : "0");
      if (on) resetSource(name); // switching back on is a request to try again now
      audit("info", "settings.source", `${SOURCE_LABEL[name]} turned ${on ? "on" : "off"}`);
    }
  }
  if (body.auto !== undefined) {
    setSetting("auto", body.auto ? "1" : "0");
    audit("info", "settings.auto", `Automatic checks turned ${body.auto ? "on" : "off"}`);
  }
  reschedule();
  return changed(c);
});

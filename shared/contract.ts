import { z } from "zod";

export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 86_400_000;
export const MAX_CHANNELS = 500;
export const MAX_MESSAGE_LENGTH = 1000;

/** What a notification is about. `vod` = a finished stream or a regular upload, `short` = a YouTube Short. */
export const CONTENT_KINDS = ["upcoming", "live", "vod", "short"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export const KIND_LABEL: Record<ContentKind, string> = { upcoming: "Upcoming", live: "Live", vod: "VOD", short: "Shorts" };
export const MAX_ROLES_PER_CHANNEL = 10;
export const MAX_MANUAL_VIDEOS = 10; // per channel

export const HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;
export const ROLE_ID_RE = /^\d{17,20}$/; // Discord snowflake
export const VIDEO_ID_RE = /^[\w-]{11}$/;
export const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
export const WEBHOOK_RE =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks\/\d{15,25}\/[\w-]{20,}$/;

/** Accepts a bare 11-character id or a watch / live / shorts / embed / youtu.be link. Returns null for anything else. */
export function parseVideoId(input: string): string | null {
  const text = input.trim();
  if (VIDEO_ID_RE.test(text)) return text;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    const host = url.hostname.replace(/^(?:www|m|music)\./, "");
    let id: string | null | undefined;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    else if (host === "youtube.com") id = url.searchParams.get("v") ?? /^\/(?:live|shorts|embed)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1];
    return id && VIDEO_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

export function isProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return PROXY_PROTOCOLS.has(url.protocol) && url.hostname !== "" && url.pathname.replace(/\/+$/, "") === "" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export const AUDIT_LEVELS = ["info", "warn", "error"] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

export const uuid = z.uuid();
const name = z.string().trim().min(1, "Name is required").max(80, "Name is too long (max 80)");
const handle = z
  .string()
  .trim()
  .transform((s) => (s.startsWith("@") ? s : `@${s}`))
  .pipe(z.string().regex(HANDLE_RE, "Invalid YouTube handle (example: @channelname)"));
const webhookIds = z.array(uuid).max(25);
const message = z
  .string()
  .max(MAX_MESSAGE_LENGTH, `Message is too long (max ${MAX_MESSAGE_LENGTH})`)
  .nullable()
  .transform((s) => s?.trim() || null);
const kindPatch = z.object({ enabled: z.boolean().optional(), message: message.optional() });
const roleIds = z
  .array(z.string().trim().regex(ROLE_ID_RE, "A role id is 17 to 20 digits"))
  .max(MAX_ROLES_PER_CHANNEL, `At most ${MAX_ROLES_PER_CHANNEL} roles per channel`)
  .transform((ids) => [...new Set(ids)]);
const videoRef = z
  .string()
  .trim()
  .max(300)
  .refine((s) => parseVideoId(s) !== null, "Not a YouTube video link or id")
  .transform((s) => parseVideoId(s)!);
const proxyUrl = z
  .string()
  .trim()
  .max(300)
  .nullable()
  .transform((s) => s || null)
  .refine((s) => s === null || isProxyUrl(s), "Proxy must look like http://host:port or socks5://host:port");

export const schemas = {
  channelCreate: z.object({ handle, webhookIds: webhookIds.default([]) }),
  channelPatch: z.object({
    enabled: z.boolean().optional(),
    webhookIds: webhookIds.optional(),
    kinds: z.object({ upcoming: kindPatch.optional(), live: kindPatch.optional(), vod: kindPatch.optional(), short: kindPatch.optional() }).optional(),
    roleIds: roleIds.optional(),
  }),
  manualVideoCreate: z.object({ url: videoRef }),
  webhookCreate: z.object({ name, url: z.string().trim().regex(WEBHOOK_RE, "Invalid Discord webhook URL") }),
  webhookPatch: z.object({ enabled: z.boolean().optional(), name: name.optional() }),
  settings: z
    .object({
      intervalMs: z
        .int("Interval must be a whole number")
        .min(MIN_INTERVAL_MS, `Interval must be at least ${MIN_INTERVAL_MS / 1000} seconds`)
        .max(MAX_INTERVAL_MS, `Interval must be at most ${MAX_INTERVAL_MS / 3_600_000} hours`)
        .optional(),
      auto: z.boolean().optional(),
      proxyUrl: proxyUrl.optional(),
      sources: z
        .object({ rss: z.boolean().optional(), scrape: z.boolean().optional(), api: z.boolean().optional() })
        .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change")
        .optional(),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change"),
  auditQuery: z.object({
    level: z.enum(AUDIT_LEVELS).optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
};

export type ChannelCreateInput = z.input<typeof schemas.channelCreate>;
export type ChannelPatchInput = z.input<typeof schemas.channelPatch>;
export type ManualVideoCreateInput = z.input<typeof schemas.manualVideoCreate>;
export type WebhookCreateInput = z.input<typeof schemas.webhookCreate>;
export type WebhookPatchInput = z.input<typeof schemas.webhookPatch>;
export type SettingsInput = z.input<typeof schemas.settings>;

export const SOURCE_NAMES = ["rss", "scrape", "api"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];
/** Where a channel's last answer came from. `manual` = only the videos added by hand were read. */
export type CheckSource = SourceName | "manual";

export interface ManualVideoDto {
  videoId: string;
  addedAt: number; // unix seconds
}

export interface KindSettingDto {
  enabled: boolean; // announce this kind for the channel
  message: string | null; // custom Discord text; `{user}` = the handle, `@{roleid}` = the roles of the channel
}

export interface ChannelDto {
  id: string;
  handle: string;
  name: string | null;
  enabled: boolean;
  checkedAt: number | null; // unix seconds
  upcoming: number;
  live: number;
  source: CheckSource | null;
  error: string | null;
  webhookIds: string[];
  kinds: Record<ContentKind, KindSettingDto>;
  roleIds: string[];
  manualVideos: ManualVideoDto[];
}

export interface WebhookDto {
  id: string;
  name: string;
  preview: string; // never contains any part of the secret token
  enabled: boolean;
  error: string | null;
}

export interface RecentDto {
  webhookId: string;
  videoId: string;
  title: string;
  handle: string;
  webhook: string;
  status: ContentKind;
  canResend: boolean;
  startAt: number | null; // unix seconds: the start of a stream, or the publish time of a VOD or Short
  sentAt: number; // unix seconds
}

export interface CycleDto {
  auto: boolean;
  running: boolean;
  intervalMs: number;
  online: boolean; // false while the connection is down: checks wait and start again by themselves
  lastCycleAt: number | null; // unix milliseconds
  nextCycleAt: number | null; // unix milliseconds, null while auto checks are off
}

export interface SourceStateDto {
  enabled: boolean; // the switch in the dashboard
  configured: boolean; // false only for the API without a key
  pausedUntil: number | null; // unix milliseconds, set while the source is backing off after repeated failures
  error: string | null; // the last failure
}

export interface SourcesDto {
  sources: Record<SourceName, SourceStateDto>;
  proxy: { url: string; healthy: boolean; error: string | null } | null; // url never contains credentials
}

export interface Overview {
  /** Increases with every snapshot, so the dashboard can drop a stale one that arrives late. */
  rev: number;
  cycle: CycleDto;
  sources: SourcesDto;
  channels: ChannelDto[];
  webhooks: WebhookDto[];
  recent: RecentDto[];
}

export interface CheckSummary {
  channels: number;
  sent: number;
  failed: number;
  /** A live or upcoming stream was found, but this webhook already got that message. */
  already: number;
  /** A live or upcoming stream was found, but that kind is switched off for the channel. */
  disabled: number;
  /** A live or upcoming stream was found, but the channel has no webhook. */
  unlinked: number;
}

export interface CheckDoneEvent extends CheckSummary {
  target: string;
}

export interface AuditDto {
  id: number;
  at: number; // unix milliseconds
  level: AuditLevel;
  kind: string;
  message: string;
}

export interface AuditPage {
  items: AuditDto[];
  nextBefore: number | null;
}

export interface StreamSentEvent {
  title: string;
  videoId: string;
  handle: string;
  webhookName: string;
  startAt: number | null;
  sentAt: number;
}

export interface NetworkEvent {
  online: boolean;
}

export interface ChannelErrorEvent {
  channelId: string;
  handle: string;
  error: string;
}

export type WsMessage =
  | { type: "overview"; data: Overview }
  | { type: "audit" }
  | { type: "stream_sent"; data: StreamSentEvent }
  | { type: "channel_error"; data: ChannelErrorEvent }
  | { type: "check_done"; data: CheckDoneEvent }
  | { type: "network"; data: NetworkEvent };

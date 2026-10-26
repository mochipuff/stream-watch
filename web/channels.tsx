import { memo, useDeferredValue, useMemo, useState } from "react";
import { CONTENT_KINDS, KIND_LABEL, MAX_MANUAL_VIDEOS, MAX_MESSAGE_LENGTH } from "../shared/contract.ts";
import type { ChannelDto, ContentKind, WebhookDto } from "../shared/contract.ts";
import { api, useAction } from "./api.ts";
import { ChipGroup, Dialog, MenuButton, RelativeTime, Row, Section, buttonCls, inputCls, quietCls } from "./ui.tsx";

const PAGE_SIZE = 10;

type ChannelState = "active" | "paused" | "error";
type Filter = "all" | ChannelState;

const SOURCE_LABEL = { rss: "RSS", scrape: "page scraping", api: "YouTube API", manual: "manual videos only" } as const;

// An error only counts while the channel is actually checked: one with no active webhook is skipped, so its error is stale.
function stateOf(channel: ChannelDto, activeHooks: number): ChannelState {
  if (!channel.enabled) return "paused";
  return channel.error && activeHooks > 0 ? "error" : "active";
}

function WebhookPicker({ webhooks, selected, onChange }: { webhooks: readonly WebhookDto[]; selected: readonly string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {webhooks.map((w) => {
        const on = selected.includes(w.id);
        return (
          <button
            type="button"
            key={w.id}
            aria-pressed={on}
            title={w.preview}
            onClick={() => onChange(on ? selected.filter((id) => id !== w.id) : [...selected, w.id])}
            className={`cursor-pointer rounded border px-2.5 py-1 text-xs transition-colors ${
              on ? "border-ink bg-ink font-medium text-white" : "border-line bg-white text-muted hover:border-ink"
            }`}
          >
            {on ? "✓ " : "+ "}
            {w.name}
          </button>
        );
      })}
    </div>
  );
}

function AddChannelForm({ webhooks }: { webhooks: readonly WebhookDto[] }) {
  const [handle, setHandle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const add = useAction(api.addChannel, "Channel added");

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        // A webhook deleted while this form was open must not be sent along.
        const webhookIds = selected.filter((id) => webhooks.some((w) => w.id === id));
        add.mutate(
          { handle, webhookIds },
          {
            onSuccess: () => {
              setHandle("");
              setSelected([]);
            },
          },
        );
      }}
    >
      <div className="flex gap-2">
        <input
          className={`${inputCls} min-w-0 flex-1`}
          aria-label="YouTube handle"
          placeholder="@channelname"
          autoComplete="off"
          spellCheck={false}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          required
        />
        <button className={buttonCls} disabled={add.isPending}>
          Add channel
        </button>
      </div>
      {webhooks.length > 0 && (
        <div className="rounded-md border border-line bg-paper/50 p-3">
          <p className="mb-2 text-xs font-semibold text-muted">Send to (pick any number of webhooks):</p>
          <WebhookPicker webhooks={webhooks} selected={selected} onChange={setSelected} />
        </div>
      )}
    </form>
  );
}

function ChannelWebhooksDialog({ channel, webhooks, onClose }: { channel: ChannelDto; webhooks: readonly WebhookDto[]; onClose: () => void }) {
  const [selected, setSelected] = useState<string[]>(channel.webhookIds);
  const save = useAction(() => api.patchChannel(channel.id, { webhookIds: selected }));

  return (
    <Dialog title={`Webhooks for ${channel.handle}`} hint="Pick where new streams from this channel are sent." onClose={onClose}>
      <div className="mt-4 max-h-60 overflow-y-auto">
        {webhooks.length === 0 ? (
          <p className="text-xs text-muted">No webhooks yet. Add one below the channel list first.</p>
        ) : (
          <WebhookPicker webhooks={webhooks} selected={selected} onChange={setSelected} />
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className={quietCls} onClick={onClose}>
          Cancel
        </button>
        <button className={buttonCls} disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
          Save
        </button>
      </div>
    </Dialog>
  );
}

const KIND_HINT: Record<ContentKind, string> = {
  upcoming: "A scheduled stream or premiere.",
  live: "A stream that is running now.",
  vod: "A regular upload, or the replay of a finished stream that was not announced before. Only videos published after you switch this on are sent.",
  short: "A YouTube Short. Only Shorts published after you switch this on are sent.",
};

function ChannelMessageDialog({ channel, onClose }: { channel: ChannelDto; onClose: () => void }) {
  const [drafts, setDrafts] = useState(() => Object.fromEntries(CONTENT_KINDS.map((k) => [k, { enabled: channel.kinds[k].enabled, message: channel.kinds[k].message ?? "" }])) as Record<ContentKind, { enabled: boolean; message: string }>);
  const [kind, setKind] = useState<ContentKind>("upcoming");
  const draft = drafts[kind];
  const change = (next: Partial<typeof draft>) => setDrafts((all) => ({ ...all, [kind]: { ...all[kind], ...next } }));
  const save = useAction(() =>
    api.patchChannel(channel.id, {
      kinds: Object.fromEntries(CONTENT_KINDS.map((k) => [k, { enabled: drafts[k].enabled, message: drafts[k].message.trim() || null }])),
    }),
  );

  return (
    <Dialog
      title={`Messages for ${channel.handle}`}
      hint="Sent above the embed. {user} becomes the handle. Mention the Discord way: <@&roleId>, <@userId>, @everyone or @here. Leave a message empty to send the embed only."
      onClose={onClose}
    >
      <div className="mt-4">
        <ChipGroup
          label="Kind of video"
          value={kind}
          onChange={setKind}
          options={CONTENT_KINDS.map((k) => ({ value: k, label: `${KIND_LABEL[k]}${drafts[k].enabled ? " ✓" : ""}` }))}
        />
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs font-semibold">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
        Announce {KIND_LABEL[kind]}
      </label>
      <p className="mt-1 text-xs text-muted">{KIND_HINT[kind]}</p>
      <label className="mt-3 block text-xs font-semibold text-muted" htmlFor="channel-message">
        {KIND_LABEL[kind]} message
      </label>
      <textarea
        id="channel-message"
        className={`${inputCls} mt-1 w-full`}
        rows={4}
        maxLength={MAX_MESSAGE_LENGTH}
        placeholder="<@&123456789012345678> {user} is streaming!"
        value={draft.message}
        onChange={(e) => change({ message: e.target.value })}
      />
      <div className="mt-5 flex justify-end gap-2">
        <button className={quietCls} onClick={onClose}>
          Cancel
        </button>
        <button className={buttonCls} disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
          Save
        </button>
      </div>
    </Dialog>
  );
}

function ChannelVideosDialog({ channel, onClose }: { channel: ChannelDto; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const add = useAction((link: string) => api.addVideo(channel.id, { url: link }), "Video added. Press Check to read it now.");
  const remove = useAction((videoId: string) => api.removeVideo(channel.id, videoId));

  return (
    <Dialog
      title={`Videos for ${channel.handle}`}
      hint="Paste a stream or premiere link. It is checked with this channel even when RSS, page scraping and the API all fail, and removed once it is no longer live or upcoming."
      onClose={onClose}
    >
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(url, { onSuccess: () => setUrl("") });
        }}
      >
        <input
          className={`${inputCls} min-w-0 flex-1`}
          aria-label="YouTube video link"
          placeholder="https://www.youtube.com/watch?v=…"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <button className={buttonCls} disabled={add.isPending || channel.manualVideos.length >= MAX_MANUAL_VIDEOS}>
          Add
        </button>
      </form>
      <ul className="mt-3 max-h-60 overflow-y-auto">
        {channel.manualVideos.length === 0 && <li className="py-2 text-xs text-muted">No videos added by hand.</li>}
        {channel.manualVideos.map((v) => (
          <li key={v.videoId} className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
            <a
              className="truncate font-mono text-xs underline"
              href={`https://www.youtube.com/watch?v=${v.videoId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {v.videoId}
            </a>
            <span className="shrink-0 text-xs text-muted">
              added <RelativeTime at={v.addedAt * 1000} />
            </span>
            <button className={quietCls} disabled={remove.isPending} onClick={() => remove.mutate(v.videoId)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-end">
        <button className={quietCls} onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

interface ChannelRowProps {
  channel: ChannelDto;
  activeHooks: number;
  busy: boolean;
  checkBlocked: boolean;
  onEdit: (id: string) => void;
  onMessage: (id: string) => void;
  onVideos: (id: string) => void;
  onCheck: (id: string) => void;
  onToggle: (v: { id: string; enabled: boolean }) => void;
  onRemove: (id: string) => void;
}

const ChannelRow = memo(function ChannelRow({ channel, activeHooks, busy, checkBlocked, onEdit, onMessage, onVideos, onCheck, onToggle, onRemove }: ChannelRowProps) {
  const total = channel.webhookIds.length;
  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{channel.handle}</span>
          {channel.name && <span className="truncate text-xs font-normal text-muted">{channel.name}</span>}
          <button
            onClick={() => onEdit(channel.id)}
            className="shrink-0 cursor-pointer rounded border border-line bg-paper px-2 py-0.5 text-[11px] font-normal text-muted hover:text-ink"
          >
            {total === 0 ? "⚠ No webhooks" : `${total} webhook${total > 1 ? "s" : ""}`}
          </button>
          <button
            onClick={() => onMessage(channel.id)}
            className="shrink-0 cursor-pointer rounded border border-line bg-paper px-2 py-0.5 text-[11px] font-normal text-muted hover:text-ink"
          >
            {CONTENT_KINDS.some((k) => channel.kinds[k].message) ? "Messages ✓" : "Messages"}
          </button>
          <button
            onClick={() => onVideos(channel.id)}
            className="shrink-0 cursor-pointer rounded border border-line bg-paper px-2 py-0.5 text-[11px] font-normal text-muted hover:text-ink"
          >
            {channel.manualVideos.length > 0 ? `Videos (${channel.manualVideos.length})` : "Videos"}
          </button>
        </span>
      }
      error={channel.enabled && activeHooks > 0 ? channel.error : null}
      detail={
        !channel.enabled ? (
          "Paused"
        ) : activeHooks === 0 ? (
          "No active webhook, so this channel is not checked automatically"
        ) : channel.checkedAt ? (
          <>
            {channel.upcoming} upcoming, {channel.live} live, checked <RelativeTime at={channel.checkedAt * 1000} />
            {channel.source && ` via ${SOURCE_LABEL[channel.source]}`}
          </>
        ) : (
          "Waiting for first check"
        )
      }
    >
      <MenuButton
        label={`Actions for ${channel.handle}`}
        actions={[
          ...(channel.enabled ? [{ label: "Check now", disabled: busy || checkBlocked, onSelect: () => onCheck(channel.id) }] : []),
          { label: channel.enabled ? "Pause" : "Resume", disabled: busy, onSelect: () => onToggle({ id: channel.id, enabled: !channel.enabled }) },
          { label: "Remove", disabled: busy, confirm: true, onSelect: () => onRemove(channel.id) },
        ]}
      />
    </Row>
  );
});

function Pagination({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (page: number) => void }) {
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3 text-xs text-muted">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button className={quietCls} disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page + 1} of {pageCount}
        </span>
        <button className={quietCls} disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export const ChannelsSection = memo(function ChannelsSection({ channels, webhooks, running }: { channels: readonly ChannelDto[]; webhooks: readonly WebhookDto[]; running: boolean }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [videosId, setVideosId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const toggle = useAction((v: { id: string; enabled: boolean }) => api.patchChannel(v.id, { enabled: v.enabled }));
  const remove = useAction(api.removeChannel);
  const check = useAction(api.checkChannel);
  const query = useDeferredValue(search).trim().toLowerCase();

  const activeHooks = useMemo(() => {
    const enabled = new Set(webhooks.filter((w) => w.enabled).map((w) => w.id));
    return new Map(channels.map((c) => [c.id, c.webhookIds.filter((id) => enabled.has(id)).length]));
  }, [channels, webhooks]);
  const states = useMemo(() => new Map(channels.map((c) => [c.id, stateOf(c, activeHooks.get(c.id) ?? 0)])), [channels, activeHooks]);
  const counts = useMemo(() => {
    const n = { all: channels.length, active: 0, paused: 0, error: 0 };
    for (const state of states.values()) n[state]++;
    return n;
  }, [channels, states]);
  const matches = useMemo(
    () =>
      channels.filter(
        (c) =>
          (filter === "all" || states.get(c.id) === filter) &&
          (!query || c.handle.toLowerCase().includes(query) || (c.name?.toLowerCase().includes(query) ?? false)),
      ),
    [channels, states, filter, query],
  );

  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const rows = matches.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const editing = channels.find((c) => c.id === editingId);
  const messaging = channels.find((c) => c.id === messageId);
  const videoEditing = channels.find((c) => c.id === videosId);

  return (
    <Section title="Channels" hint="Every handle can send to its own webhooks, or to several at once.">
      {editing && <ChannelWebhooksDialog key={editing.id} channel={editing} webhooks={webhooks} onClose={() => setEditingId(null)} />}
      {messaging && <ChannelMessageDialog key={messaging.id} channel={messaging} onClose={() => setMessageId(null)} />}
      {videoEditing && <ChannelVideosDialog key={videoEditing.id} channel={videoEditing} onClose={() => setVideosId(null)} />}
      <AddChannelForm webhooks={webhooks} />
      {channels.length > 0 && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            type="search"
            className={`${inputCls} min-w-0 sm:w-64`}
            aria-label="Search channels"
            placeholder="Search channels"
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
          <ChipGroup
            label="Filter by status"
            value={filter}
            onChange={(next) => {
              setFilter(next);
              setPage(0);
            }}
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "active", label: "Active", count: counts.active },
              { value: "paused", label: "Paused", count: counts.paused },
              { value: "error", label: "Error", count: counts.error },
            ]}
          />
        </div>
      )}
      <ul className="mt-2">
        {channels.length === 0 && <li className="py-3 text-sm text-muted">No channels yet. Add a handle above.</li>}
        {channels.length > 0 && matches.length === 0 && <li className="py-3 text-sm text-muted">No channel matches this search and filter.</li>}
        {rows.map((c) => (
          <ChannelRow
            key={c.id}
            channel={c}
            activeHooks={activeHooks.get(c.id) ?? 0}
            busy={(toggle.isPending && toggle.variables?.id === c.id) || (remove.isPending && remove.variables === c.id)}
            checkBlocked={running || check.isPending}
            onEdit={setEditingId}
            onMessage={setMessageId}
            onVideos={setVideosId}
            onCheck={check.mutate}
            onToggle={toggle.mutate}
            onRemove={remove.mutate}
          />
        ))}
      </ul>
      {matches.length > PAGE_SIZE && <Pagination page={current} pageCount={pageCount} total={matches.length} onPage={setPage} />}
    </Section>
  );
});

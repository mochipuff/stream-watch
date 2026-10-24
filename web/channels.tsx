import { memo, useDeferredValue, useMemo, useState } from "react";
import type { ChannelDto, WebhookDto } from "../shared/contract.ts";
import { api, useAction } from "./api.ts";
import { ChipGroup, ConfirmButton, Dialog, RelativeTime, Row, Section, buttonCls, inputCls, quietCls } from "./ui.tsx";

const PAGE_SIZE = 10;

type ChannelState = "active" | "paused" | "error";
type Filter = "all" | ChannelState;

const SOURCE_LABEL = { rss: "RSS", api: "YouTube API" } as const;

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

interface ChannelRowProps {
  channel: ChannelDto;
  activeHooks: number;
  busy: boolean;
  checkBlocked: boolean;
  onEdit: (id: string) => void;
  onCheck: (id: string) => void;
  onToggle: (v: { id: string; enabled: boolean }) => void;
  onRemove: (id: string) => void;
}

const ChannelRow = memo(function ChannelRow({ channel, activeHooks, busy, checkBlocked, onEdit, onCheck, onToggle, onRemove }: ChannelRowProps) {
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
      {channel.enabled && (
        <button className={quietCls} disabled={busy || checkBlocked} onClick={() => onCheck(channel.id)}>
          Check
        </button>
      )}
      <button className={quietCls} disabled={busy} onClick={() => onToggle({ id: channel.id, enabled: !channel.enabled })}>
        {channel.enabled ? "Pause" : "Resume"}
      </button>
      <ConfirmButton label="Remove" disabled={busy} onConfirm={() => onRemove(channel.id)} />
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

  return (
    <Section title="Channels" hint="Every handle can send to its own webhooks, or to several at once.">
      {editing && <ChannelWebhooksDialog key={editing.id} channel={editing} webhooks={webhooks} onClose={() => setEditingId(null)} />}
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

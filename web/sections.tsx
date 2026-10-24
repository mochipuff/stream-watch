import { memo, useState } from "react";
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS } from "../shared/contract.ts";
import type { CycleDto, RecentDto, SourcesDto, WebhookDto } from "../shared/contract.ts";
import { api, useAction } from "./api.ts";
import { ConfirmButton, RelativeTime, Row, Section, buttonCls, inputCls, quietCls } from "./ui.tsx";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtTime = (unix: number | null) => (unix ? dateTime.format(unix * 1000) : "no start time");

function AddWebhookForm() {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const add = useAction(api.addWebhook, "Webhook added");

  return (
    <form
      className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          { name, url },
          {
            onSuccess: () => {
              setName("");
              setUrl("");
            },
          },
        );
      }}
    >
      <input className={inputCls} aria-label="Webhook label" placeholder="Label (e.g. My Server)" value={name} onChange={(e) => setName(e.target.value)} required />
      <input
        className={inputCls}
        aria-label="Webhook URL"
        placeholder="https://discord.com/api/webhooks/…"
        autoComplete="off"
        spellCheck={false}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
      />
      <button className={buttonCls} disabled={add.isPending}>
        Add webhook
      </button>
    </form>
  );
}

interface WebhookRowProps {
  webhook: WebhookDto;
  busy: boolean;
  onTest: (id: string) => void;
  onToggle: (v: { id: string; enabled: boolean }) => void;
  onRemove: (id: string) => void;
}

const WebhookRow = memo(function WebhookRow({ webhook: w, busy, onTest, onToggle, onRemove }: WebhookRowProps) {
  return (
    <Row title={w.name} detail={w.enabled ? w.preview : `Paused, ${w.preview}`} error={w.error}>
      <button className={quietCls} disabled={busy} onClick={() => onTest(w.id)}>
        Send test
      </button>
      <button className={quietCls} disabled={busy} onClick={() => onToggle({ id: w.id, enabled: !w.enabled })}>
        {w.enabled ? "Pause" : "Resume"}
      </button>
      <ConfirmButton label="Remove" disabled={busy} onConfirm={() => onRemove(w.id)} />
    </Row>
  );
});

export const WebhooksSection = memo(function WebhooksSection({ webhooks }: { webhooks: readonly WebhookDto[] }) {
  const test = useAction(api.testWebhook, "Test message sent to Discord.");
  const toggle = useAction((v: { id: string; enabled: boolean }) => api.patchWebhook(v.id, { enabled: v.enabled }));
  const remove = useAction(api.removeWebhook);

  return (
    <Section
      title="Discord webhooks"
      hint="The name is only a label so you remember which server this webhook posts to. In Discord, messages use the webhook's own name and avatar."
    >
      <AddWebhookForm />
      <ul className="mt-3">
        {webhooks.length === 0 && <li className="py-3 text-sm text-muted">No webhooks yet.</li>}
        {webhooks.map((w) => (
          <WebhookRow
            key={w.id}
            webhook={w}
            busy={(test.isPending && test.variables === w.id) || (toggle.isPending && toggle.variables?.id === w.id) || (remove.isPending && remove.variables === w.id)}
            onTest={test.mutate}
            onToggle={toggle.mutate}
            onRemove={remove.mutate}
          />
        ))}
      </ul>
    </Section>
  );
});

function IntervalForm({ intervalMs }: { intervalMs: number }) {
  const [seconds, setSeconds] = useState(String(intervalMs / 1000));
  const save = useAction(() => api.saveSettings({ intervalMs: Math.round(Number(seconds) * 1000) }), "Interval saved.");

  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <input
        type="number"
        min={MIN_INTERVAL_MS / 1000}
        max={MAX_INTERVAL_MS / 1000}
        step="1"
        className={`${inputCls} w-28`}
        aria-label="Interval in seconds"
        value={seconds}
        onChange={(e) => setSeconds(e.target.value)}
        required
      />
      <button className={buttonCls} disabled={save.isPending}>
        Save interval
      </button>
    </form>
  );
}

export const CycleSection = memo(function CycleSection({ cycle }: { cycle: CycleDto }) {
  const toggle = useAction(() => api.saveSettings({ auto: !cycle.auto }));

  return (
    <Section title="Check cycle" hint={`Seconds between automatic checks. Minimum ${MIN_INTERVAL_MS / 1000}. Check now always works, even with automatic checks off.`}>
      <ul className="mb-4">
        <Row title={`Automatic checks are ${cycle.auto ? "on" : "off"}`} detail={cycle.auto ? "Channels are checked on the interval below." : "Nothing is checked until you press Check now."}>
          <button className={quietCls} disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {cycle.auto ? "Turn off" : "Turn on"}
          </button>
        </Row>
      </ul>
      {/* Remounting on a new saved value resets the field to it, with no effect needed to sync state. */}
      <IntervalForm key={cycle.intervalMs} intervalMs={cycle.intervalMs} />
    </Section>
  );
});

function ProxyForm() {
  const [url, setUrl] = useState("");
  const save = useAction(() => api.saveSettings({ proxyUrl: url }), "Proxy saved.");

  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: () => setUrl("") });
      }}
    >
      <input
        className={`${inputCls} min-w-0 flex-1`}
        aria-label="Proxy URL"
        placeholder="http://user:pass@host:8080 or socks5://host:1080"
        autoComplete="off"
        spellCheck={false}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
      />
      <button className={buttonCls} disabled={save.isPending}>
        Save proxy
      </button>
    </form>
  );
}

export const SourcesSection = memo(function SourcesSection({ sources }: { sources: SourcesDto }) {
  const clear = useAction(() => api.saveSettings({ proxyUrl: null }), "Proxy removed.");
  const { proxy, apiConfigured } = sources;

  return (
    <Section title="Sources and proxy" hint="Channels are read from the YouTube RSS feed. If that fails, the YouTube API takes over when a key is set.">
      <ul className="mb-4">
        <Row
          title="YouTube API v3 fallback"
          detail={apiConfigured ? "Key set. Used only when RSS fails." : "Not set. Add YOUTUBE_API_KEY to .env and restart to enable it."}
        />
        <Row
          title="Proxy"
          detail={proxy ? `${proxy.url}, ${proxy.healthy ? "ready" : "not working"}` : "None, direct connection"}
          error={proxy && !proxy.healthy ? `${proxy.url} failed (${proxy.error ?? "unknown error"}). Using a direct connection for now.` : null}
        >
          {proxy && (
            <button className={quietCls} disabled={clear.isPending} onClick={() => clear.mutate()}>
              Remove
            </button>
          )}
        </Row>
      </ul>
      <ProxyForm />
      <p className="mt-2 text-xs text-muted">Applies to requests to YouTube only. If the proxy fails, requests go out directly.</p>
    </Section>
  );
});

const RecentRow = memo(function RecentRow({ item: r, busy, onResend }: { item: RecentDto; busy: boolean; onResend: (r: RecentDto) => void }) {
  return (
    <Row
      title={r.title}
      detail={
        <>
          {r.handle} to {r.webhook}, {r.status === "live" ? "live" : `starts ${fmtTime(r.startAt)}`}, sent <RelativeTime at={r.sentAt * 1000} />
        </>
      }
    >
      {r.canResend && (
        <button className={quietCls} disabled={busy} onClick={() => onResend(r)}>
          Send again
        </button>
      )}
      <a className={quietCls} href={`https://www.youtube.com/watch?v=${r.videoId}`} target="_blank" rel="noopener noreferrer">
        Open
      </a>
    </Row>
  );
});

export const RecentSection = memo(function RecentSection({ recent }: { recent: readonly RecentDto[] }) {
  const resend = useAction((r: RecentDto) => api.resend(r.webhookId, r.videoId), (r) => `Sent again to ${r.webhook}.`);

  return (
    <Section title="Recently sent">
      <ul>
        {recent.length === 0 && <li className="py-1 text-sm text-muted">Nothing sent yet. Streams appear here once announced.</li>}
        {recent.map((r) => (
          <RecentRow
            key={`${r.webhookId}-${r.videoId}`}
            item={r}
            busy={resend.isPending && resend.variables?.webhookId === r.webhookId && resend.variables.videoId === r.videoId}
            onResend={resend.mutate}
          />
        ))}
      </ul>
    </Section>
  );
});

import { useState, type FormEvent } from "react";
import type { CycleDto } from "../shared/contract.ts";
import { ActivitySection } from "./activity.tsx";
import { OVERVIEW_KEY, ApiError, api, auth, lock, queryClient, useAction, useOverview, useToken } from "./api.ts";
import { ChannelsSection } from "./channels.tsx";
import { useRealtime } from "./realtime.ts";
import { CycleSection, RecentSection, SourcesSection, WebhooksSection } from "./sections.tsx";
import { ChipGroup, RelativeTime, ToastContainer, buttonCls, inputCls, quietCls, useNow } from "./ui.tsx";

function Gate() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const candidate = value.trim();
    setPending(true);
    setError("");
    try {
      // Checked with the typed token before it is stored, so a wrong one never flashes the dashboard.
      queryClient.setQueryData(OVERVIEW_KEY, await api.overview(candidate));
      auth.set(candidate);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "That token is not correct." : err instanceof Error ? err.message : "Request failed");
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Stream Watch</h1>
      <p className="text-sm text-muted">Enter the admin token from your server settings to open the dashboard.</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Admin token"
          className={inputCls}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        {error && <p className="text-sm text-signal">{error}</p>}
        <button className={buttonCls} disabled={pending}>
          Open dashboard
        </button>
      </form>
    </main>
  );
}

function StatusLine({ cycle, hasHooks, connected }: { cycle: CycleDto; hasHooks: boolean; connected: boolean }) {
  const now = useNow();
  const { auto, running, intervalMs, lastCycleAt } = cycle;
  const healthy = !auto || (lastCycleAt !== null && now - lastCycleAt < intervalMs * 3 + 10_000);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
      <span className={`inline-block size-2.5 rounded-full ${healthy ? "bg-ok" : "bg-signal"}`} />
      {running ? (
        "Checking…"
      ) : !hasHooks ? (
        "Paused. Add a Discord webhook to start."
      ) : (
        <>
          Last check <RelativeTime at={lastCycleAt} />, {auto ? `every ${intervalMs / 1000}s` : "automatic checks are off"}
        </>
      )}
      <span className="text-xs text-muted/60">•</span>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
          connected ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
        }`}
      >
        <span className={`size-1.5 rounded-full ${connected ? "bg-ok" : "animate-ping bg-amber-500"}`} />
        {connected ? "Live" : "Reconnecting…"}
      </span>
    </p>
  );
}

const VIEWS = [
  { value: "dashboard", label: "Dashboard" },
  { value: "activity", label: "Activity log" },
] as const;

function Dashboard() {
  const { data, error, refetch } = useOverview();
  const connected = useRealtime();
  const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("dashboard");
  const check = useAction(api.check);

  if (!data) {
    return (
      <div className="flex items-center gap-3 p-6 text-sm text-muted">
        <p>{error ? error.message : "Loading…"}</p>
        {error && (
          <>
            <button className={quietCls} onClick={() => void refetch()}>
              Retry
            </button>
            <button className={quietCls} onClick={lock}>
              Lock
            </button>
          </>
        )}
      </div>
    );
  }

  const active = data.channels.filter((c) => c.enabled).length;
  const { cycle } = data;
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Watching {active} {active === 1 ? "channel" : "channels"}
          </h1>
          <StatusLine cycle={cycle} hasHooks={data.webhooks.some((w) => w.enabled)} connected={connected} />
        </div>
        <div className="flex items-center gap-2">
          <button className={buttonCls} disabled={cycle.running || check.isPending} onClick={() => check.mutate()}>
            {cycle.running ? "Checking…" : "Check now"}
          </button>
          <button className={quietCls} onClick={lock}>
            Lock
          </button>
        </div>
      </header>
      <ChipGroup label="View" options={VIEWS} value={view} onChange={setView} />
      {view === "dashboard" ? (
        <>
          <ChannelsSection channels={data.channels} webhooks={data.webhooks} running={cycle.running} />
          <WebhooksSection webhooks={data.webhooks} />
          <CycleSection cycle={cycle} />
          <SourcesSection sources={data.sources} />
          <RecentSection recent={data.recent} />
        </>
      ) : (
        <ActivitySection />
      )}
    </main>
  );
}

export default function App() {
  const token = useToken();
  return (
    <>
      {token ? <Dashboard /> : <Gate />}
      <ToastContainer />
    </>
  );
}

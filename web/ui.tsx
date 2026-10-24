import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { dismiss, getToasts, subscribe as subscribeToasts } from "./toast.ts";

export const inputCls =
  "rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ink";
export const buttonCls =
  "rounded-md bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-black focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 disabled:opacity-50 cursor-pointer transition-colors";
export const quietCls =
  "rounded-md border border-line bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-paper focus-visible:ring-2 focus-visible:ring-ink cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

// One shared 1s clock, running only while something on screen needs it.
let now = Date.now();
let clock: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();

function subscribeToClock(listener: () => void) {
  clockListeners.add(listener);
  now = Date.now(); // a first subscriber must not start from a stale value
  clock ??= setInterval(() => {
    now = Date.now();
    clockListeners.forEach((l) => l());
  }, 1000);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      clearInterval(clock);
      clock = undefined;
    }
  };
}

export const useNow = () => useSyncExternalStore(subscribeToClock, () => now);

function ago(at: number | null, current: number) {
  if (!at) return "never";
  const s = Math.max(0, Math.round((current - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Re-renders itself every second, so the rest of the page does not have to. `at` is unix milliseconds. */
export function RelativeTime({ at }: { at: number | null }) {
  return <>{ago(at, useNow())}</>;
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white p-5 shadow-xs">
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

interface RowProps {
  title: ReactNode;
  detail: ReactNode;
  error?: string | null;
  children?: ReactNode;
}

export function Row({ title, detail, error, children }: RowProps) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className={`truncate text-xs ${error ? "text-signal" : "text-muted"}`}>{error || detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </li>
  );
}

interface ChipOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function ChipGroup<T extends string>({ label, options, value, onChange }: { label: string; options: readonly ChipOption<T>[]; value: T; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`cursor-pointer rounded border px-2.5 py-1 text-xs transition-colors ${
            o.value === value ? "border-ink bg-ink font-medium text-white" : "border-line bg-white text-muted hover:border-ink"
          }`}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1 opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// A destructive action needs a second click within 3 seconds.
export function ConfirmButton({ label, onConfirm, disabled }: { label: string; onConfirm: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      className={`${quietCls} ${armed ? "border-signal text-signal" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? "Sure?" : label}
    </button>
  );
}

// The native <dialog> gives focus trapping, Esc and a backdrop for free.
export function Dialog({ title, hint, onClose, children }: { title: string; hint?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()} // a click on the backdrop lands on the dialog itself
      className="m-auto w-full max-w-md rounded-lg bg-white p-0 text-ink shadow-xl backdrop:bg-black/40"
    >
      <div className="p-6">
        <h3 className="text-base font-semibold">{title}</h3>
        {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
        {children}
      </div>
    </dialog>
  );
}

export function ToastContainer() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed top-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start justify-between gap-3 rounded-lg border p-3.5 shadow-lg ${
            t.kind === "error"
              ? "border-signal bg-red-50 text-signal"
              : t.kind === "success"
                ? "border-ok bg-emerald-50 text-ok"
                : "border-line bg-white text-ink"
          }`}
        >
          <div className="text-xs">
            {t.title && <p className="font-semibold">{t.title}</p>}
            <p className="mt-0.5">{t.message}</p>
          </div>
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="ml-2 shrink-0 cursor-pointer text-sm font-bold text-muted hover:text-ink">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

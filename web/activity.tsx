import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { AuditDto, AuditLevel } from "../shared/contract.ts";
import { AUDIT_KEY, api } from "./api.ts";
import { ChipGroup, Section, quietCls } from "./ui.tsx";

type LevelFilter = "all" | AuditLevel;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const DOT: Record<AuditLevel, string> = { info: "bg-line", warn: "bg-amber-500", error: "bg-signal" };

function AuditRow({ entry }: { entry: AuditDto }) {
  return (
    <li className="flex gap-3 border-t border-line py-2.5 first:border-t-0">
      <span role="img" aria-label={entry.level} className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[entry.level]}`} />
      <div className="min-w-0 flex-1">
        <p className={`break-words text-sm ${entry.level === "error" ? "text-signal" : ""}`}>{entry.message}</p>
        <p className="text-xs text-muted">
          {dateTime.format(entry.at)}, {entry.kind}
        </p>
      </div>
    </li>
  );
}

export function ActivitySection() {
  const [level, setLevel] = useState<LevelFilter>("all");
  const log = useInfiniteQuery({
    queryKey: [...AUDIT_KEY, level],
    queryFn: ({ pageParam }) => api.audit({ level: level === "all" ? undefined : level, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Section title="Activity log" hint="Changes, checks, sends and problems. The newest 2000 entries are kept. Secrets are never written here.">
      <ChipGroup
        label="Filter by level"
        value={level}
        onChange={setLevel}
        options={[
          { value: "all", label: "All" },
          { value: "info", label: "Info" },
          { value: "warn", label: "Warnings" },
          { value: "error", label: "Errors" },
        ]}
      />
      <ul className="mt-3">
        {log.isPending && <li className="py-3 text-sm text-muted">Loading…</li>}
        {log.isError && (
          <li className="flex items-center gap-3 py-3 text-sm text-signal">
            {log.error.message}
            <button className={quietCls} onClick={() => void log.refetch()}>
              Retry
            </button>
          </li>
        )}
        {log.isSuccess && entries.length === 0 && <li className="py-3 text-sm text-muted">Nothing logged yet.</li>}
        {entries.map((entry) => (
          <AuditRow key={entry.id} entry={entry} />
        ))}
      </ul>
      {log.hasNextPage && (
        <div className="mt-3 flex justify-center border-t border-line pt-3">
          <button className={quietCls} disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {log.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </Section>
  );
}

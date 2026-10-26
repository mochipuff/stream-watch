# Roadmap to production grade

Each phase is small, ships alone and has a clear "done" test. Order = value for realtime and trust first.

## Phase 1 – Realtime and trust (done in this patch)
- Upcoming → Live sends the Live message once (atomic claim, rollback on a failed send).
- Manual check ignores the 5-minute memory; upcoming streams close to start are re-read every cycle.
- `/live` is asked every cycle. Interval 10s–24h (default 15s).
- Timeouts cut to 5s (YouTube), 7s (Discord), 2.5s (thumbnail); back-offs capped at 30s per channel and 2m per source.
- Offline detection with probe, auto reconnect after a stable connection, fresh sockets, cleared back-offs.
- A check that sends 0 says why.

## Phase 2 – Reliability
- Process supervisor (systemd / PM2 / Docker with `restart: always`); the dev script is not a supervisor.
- `/api/health` returns poller age, DB status and online state; alert (Discord message to an ops webhook) when no cycle finished for 3 intervals.
- Fair scheduling: read the stalest upcoming stream first (today the first 5 unknown videos win every cycle).
- Outbox table for Discord sends (claim → send → confirm) with a retry worker, so a restart never loses a notification.
- Revert unconfirmed Live promotions on start instead of deleting the row.

## Phase 3 – Quality
- Unit tests (node:test) for `classifyPlayer`, `parseKinds`, claim/promote SQL, connectivity state machine; contract test for the API.
- CI: typecheck + tests on every push.
- Fixtures of real YouTube pages to catch layout changes early.

## Phase 4 – Operations and security
- Structured JSON logs with levels; metrics endpoint (cycle time, sources up, sends, failures).
- Backup job for `data/app.db` (`VACUUM INTO`) and restore test.
- Encrypt webhook URLs at rest (key from env), keep the 127.0.0.1-only rule; if ever exposed, add real login + CSRF token.
- Dependabot / `npm audit` in CI; pin Node version in `.nvmrc`.

## Phase 5 – Product
- Per-channel quiet hours, per-kind webhook routing, templates with `{title}` `{url}` `{startTime}`.
- Optional push source (PubSubHubbub / WebSub) for near-instant new uploads and streams.

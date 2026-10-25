# Stream Watch

Checks YouTube channels for upcoming and live streams and posts them to Discord webhooks (embed + "Watch on YouTube" button). Each video is sent once per webhook. Messages use the webhook's own name and avatar from Discord; the name typed in the dashboard is only a label. Thumbnails are `i.ytimg.com` `maxresdefault` URLs that Discord loads itself (falls back to `hqdefault` when YouTube has no max-res image). Streams listed under "Recently sent" can be sent again to the same webhook. A stream is announced once per webhook, whether it was first seen as upcoming or already live.

It is built to run on your own machine in dev mode: TypeScript everywhere, no build step, no paid server.

## Run

Requires Node 24 or newer (24 and 26 are both LTS; it runs `.ts` files directly and ships SQLite, so nothing native to compile). `npm run typecheck` uses TypeScript 7 (the native compiler, still the `tsc` command).

```bash
npm install
npm run dev
```

Open http://localhost:5173. There is no login: the API only listens on 127.0.0.1 and only answers this machine's own dashboard (see Security). The API starts first on http://127.0.0.1:8787 and Vite starts once it answers. The database is created at `data/app.db` on API start.

Separate terminals also work: `npm run dev:server` and `npm run dev:web`. `npm run typecheck` checks server, shared code and dashboard together.

The poller lives in the API process, not in the browser: closing the dashboard tab never stops it. Closing the terminal that runs `npm run dev` does.

## How channels are checked

A check has two steps: **discovery** (which videos of the channel might be live or upcoming) and **classification** (what each one is). Three discovery sources work independently, cheapest first, and each can be switched on or off under "Sources and proxy":

1. **RSS feed**: the channel's `feeds/videos.xml` lists recent uploads (a few KB). One attempt per check; if it answers 404 or 5xx, the channel's live-streams playlist feed (`playlist_id=UULV…`) is tried once. No sleeping and retrying: the next cycle is the retry.
2. **Page scraping** (no key): the channel's `/streams` tab, then the older live filters and the handle URL, and finally the `/live` page. A page only counts when it really is a channel listing, so an unreadable page is an error and never "nothing is live". Candidates are read from the open tab only and matched on badges, never on titles. These pages are 1 to 3 MB, so with RSS healthy they are re-read every 2 minutes (every minute while RSS is down); "Check now" always re-reads them. If only the `/live` page can be read, the check still works for "live now" and the log warns that YouTube may have changed its layout.
3. **YouTube Data API v3** (optional `YOUTUBE_API_KEY`): used only when RSS and page scraping both fail. It reads the live-streams and uploads playlists and classifies with `liveBroadcastContent`, about 3 units per check (the quota is 10,000 a day). The key is sent in a header, never in a URL. When the quota is used up the API is paused for 1 hour.

**One failing source never fails the check while another answers.** Each source has a breaker: after 3 failures in a row (or at once on HTTP 429, a consent page or a bot check) it rests for 30s, 60s, 2m … up to 10m, and the dashboard shows the countdown. A manual check goes around the rest period. Being offline (DNS or connection errors) never pauses a source.

**Classification** reads each candidate's own watch page and decides `live`, `upcoming` or plain; a stream with an end time is always plain, so an old VOD is never announced as live. A bot-check or sign-in page is an error and is never remembered as a plain video. Plain videos are remembered in the database and never loaded again; live and upcoming ones are re-read every 5 minutes. If watch pages cannot be read, the API classifies them.

**Videos added by hand**: the "Videos" button on a channel takes a watch, live, shorts or youtu.be link (up to 10 per channel). Those videos are checked with the channel whatever the three sources do, so they still work while everything else fails. A video of another channel is refused, and one that is no longer live or upcoming (or older than 14 days) is removed. With all three sources off, only these videos are checked.

The dashboard shows which source answered for each channel. The channel id (UC…) is resolved once and stored.

**Proxy**: set an `http://`, `https://`, `socks5://` or `socks5h://` proxy under "Sources and proxy". It applies to YouTube and Google requests only, not Discord. If the proxy fails, the request is retried directly (no proxy) and the proxy is skipped for 60 seconds. No proxy is the default. Note that a direct fallback shows this machine's own IP to YouTube.

**Automatic cycle and manual check**: automatic checks can be turned off. "Check now" (and "Check" on one channel) works either way, ignores the failure back-off, and still never sends the same stream to the same webhook twice. Manual checks are limited to one every 5 seconds.

**Message per channel**: the "Message" button on a channel sets text that is sent above the embed for that handle only. `{user}` becomes the handle (for example `@MizuHamzazu`) and `@{roleid}` becomes a mention of every role id saved for that handle (up to 10, each 17 to 20 digits). Example: `@{roleid} {user} is live!`. Only the saved roles can ping, and only when the message contains `@{roleid}`; `@everyone`, `@here` and other role ids typed by hand never notify anyone. Messages are up to 1000 characters; an empty message sends the embed alone. Existing databases get the two new columns automatically on start.

**Channel list**: search by handle or name, filter by All / Active / Paused / Error, 10 per page. At most 500 channels.

**Activity log**: changes, checks, sends, source and proxy fallbacks, and errors. Each level (info, warning, error) keeps only its newest 15 entries, so an error is never pushed out by a burst of info lines. Older entries are deleted automatically, including on the first start after this limit was introduced. Webhook tokens, proxy passwords and API keys are removed before anything is written.

## How it fits together

- `shared/contract.ts`: Zod schemas, limits and the API/WebSocket types. The server validates with it and the dashboard imports the same types.
- `server/`: Hono API (`api.ts`), check logic (`youtube.ts`), page scraping (`yt-pages.ts`), API fallback (`yt-api.ts`), source breakers (`sources.ts`), proxy-aware fetch (`http.ts`), Discord sender (`discord.ts`), poller (`poller.ts`), audit log (`audit.ts`), events (`events.ts`), WebSocket pushes (`realtime.ts`), SQLite (`db.ts`).
- `web/`: React 19 dashboard. TanStack Query holds the data; the WebSocket and every API response write the same snapshot into it, so the page never refetches after an action. The activity log is paged from the server.
- `/api/*` JSON API: `overview`, `cycle`, `check`, `channels`, `channels/:id/check`, `channels/:id/videos`, `webhooks`, `webhooks/:id/test`, `sent/:webhookId/:videoId/resend`, `settings` (`intervalMs`, `auto`, `proxyUrl`, `sources`), `audit?level=&before=&limit=`.
  - `POST /api/check` and `POST /api/channels/:id/check` start a check and answer `202` at once with the snapshot (`cycle.running` is `true`). The result arrives as a `check_done` WebSocket event and in the audit log. They answer `409` while a check is running and `429` when called again within 5 seconds.
  - `GET /api/cycle` returns `{ auto, running, intervalMs, lastCycleAt, nextCycleAt }`.
- `/api/ws` realtime WebSocket on the same port.

## Security

There is no admin key: this is a single-user tool on your own machine. Instead of a secret, the server refuses everything that does not come from its own dashboard: the `Host` must be a loopback name (stops DNS rebinding), `Origin` must match it, `Sec-Fetch-Site` must not be cross-site, and a body must be JSON. A website open in your browser cannot send anything to `http://127.0.0.1:8787`. `HOST` must be `127.0.0.1`, `localhost` or `::1`; the server refuses to start on any other address, because without a login that would hand control to the network. Any program running as you on this machine can still call the API, as it could read `data/app.db`.

## Database

Data is stored in SQLite (`DB_PATH`, default `./data/app.db`; it holds webhook URLs and the proxy URL, so keep it private). The check interval is 30s to 24h. The API only listens on 127.0.0.1.

The schema adapts itself: `PRAGMA user_version` records how far the file has been brought forward, and every step on start is idempotent. A database from any earlier release (including one from before versioning existed) is upgraded in place without losing data. Before an existing database is changed, a consistent copy is written next to it as `app.db-backup-v<from>-<timestamp>` (the newest 3 are kept). A database written by a newer version of the app is refused rather than damaged. To add a column or table, append a step to `MIGRATIONS` in `server/db.ts`; never edit a released step.

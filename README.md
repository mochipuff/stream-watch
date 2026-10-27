# Stream Watch

Checks YouTube channels for upcoming and live streams (and, when switched on per channel, new VODs and Shorts) and posts them to Discord webhooks (embed + a button: "Waiting room" on upcoming messages, "Watch on YouTube" on the rest). Each video is sent once per webhook. Messages use the webhook's own name and avatar from Discord; the name typed in the dashboard is only a label. Thumbnails are `i.ytimg.com` URLs that Discord loads itself (`maxresdefault`, then `sddefault`, then `hqdefault`, whichever YouTube actually serves; `hqdefault` also when the check cannot run). Every message gets the URL with a fresh `?v=` number and nothing is remembered between sends, so a waiting room whose thumbnail was changed by the creator (same video id) shows the new picture instead of Discord's cached copy. Streams listed under "Recently sent" can be sent again to the same webhook. A stream is announced once per webhook per stage: one Upcoming message, and one Live message when it goes live (a stream first seen live gets only the Live message).

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

**One failing source never fails the check while another answers.** Each source has a breaker: after 3 failures in a row (or at once on HTTP 429, a consent page or a bot check) it rests for 10s, 20s, 40s … up to 2m, and the dashboard shows the countdown. A manual check goes around the rest period. Being offline never pauses a source: see "Offline and reconnect" below.

**Classification** reads each candidate's own watch page and decides `live`, `upcoming`, `short` or `vod`; a stream with an end time is always a `vod`, so an old stream is never announced as live. A bot-check or sign-in page is an error and is never remembered. A `vod` or `short` never changes into anything else, so it is remembered in the database (with its title and publish time) and its page is never loaded again; a live video is re-read every 30s, an upcoming one every cycle once it starts within 10 minutes (or is late) and every 2 minutes before that. Every cycle also asks the channel's `/live` page, so a surprise stream is seen at once. If watch pages cannot be read, the API classifies them.

A Short is a video that YouTube marks as Shorts-eligible and that is at most 3 minutes long (the API fallback has no such flag and uses "at most 60 seconds"). A `vod` is every other finished video: a regular upload, or the replay of a stream. VODs and Shorts are found through the RSS feed (or the API), which list recent uploads; page scraping only looks at the streams tab, so with RSS and the API both down only streams are found.

**Videos added by hand**: the "Videos" button on a channel takes a watch, live, shorts or youtu.be link (up to 10 per channel). Those videos are checked with the channel whatever the three sources do, so they still work while everything else fails. A video of another channel is refused, and one that is no longer live or upcoming (or older than 14 days) is removed. With all three sources off, only these videos are checked.

The dashboard shows which source answered for each channel. The channel id (UC…) is resolved once and stored.

**Offline and reconnect**: a failed request starts a small probe (`youtube.com/generate_204`, through the same proxy route). Two failed probes in a row mean offline: checks pause, nothing is counted as a failure and the dashboard says so. Three good probes in a row (about 6s of stable connection) mean online: back-offs and source pauses are cleared, old connections are replaced and a check starts at once. Timeouts are short (5s for YouTube, 7s for Discord), so a bad line never holds a check for long. A send that fails because the line dropped is retried on the next cycle.

**A check that sends nothing says why**: the "Check finished" message and the activity log add the reason, for example `0 sent (1 already sent before)`, `switched off for the channel` or `on a channel without webhook`.

**Proxy**: set an `http://`, `https://`, `socks5://` or `socks5h://` proxy under "Sources and proxy". It applies to YouTube and Google requests only, not Discord. If the proxy fails, the request is retried directly (no proxy) and the proxy is skipped for 60 seconds. No proxy is the default. Note that a direct fallback shows this machine's own IP to YouTube.

**Automatic cycle and manual check**: automatic checks can be turned off. "Check now" (and "Check" on one channel) works either way, ignores the failure back-off, and still never sends the same stream to the same webhook twice. Manual checks are limited to one every 5 seconds.

**Messages per channel and kind**: the "Messages" button on a channel has one tab for each kind (Upcoming, Live, VOD, Shorts). Every kind has its own on/off switch and its own text, sent above the embed for that handle only. `{user}` becomes the handle (for example `@MizuHamzazu`). Mentions are typed the Discord way inside the message: `<@&roleId>` for a role, `<@userId>` for a person, `@everyone` and `@here`. Example: `<@&123456789012345678> {user} is live!`. Only the mentions typed in the message can notify anyone, and a handle can never add one (`@everyone` is a valid handle, and `{user}` is plain text). Typing `@everyone` or `@here` really pings the whole server, as it does in Discord. Messages are up to 1000 characters; an empty message sends the embed alone.
- Upcoming and Live are on by default, as before. **VOD and Shorts are off by default** and are announced only if they were published after the moment the kind was switched on, so switching it on never replays a channel's back catalogue.
- A video is still sent once per webhook. A stream that was announced as upcoming or live is not announced again as a VOD when it ends.
- A message that existed before this version becomes the Upcoming and Live message of that channel. Old `@{roleid}` tokens were converted to `<@&roleId>` mentions of the roles that channel had saved (schema step 4); the separate role list is gone.

**Channel list**: search by handle or name, filter by All / Active / Paused / Error, 10 per page. At most 500 channels. The "⋯" button on a channel (Check now, Pause or Resume, Remove) and on a webhook (Send test, Pause or Resume, Remove) opens a menu; Remove asks for a second click.

**Dev proxy log**: Vite proxies the dashboard's WebSocket to the API. Closing or reloading a tab, or the API restarting under `node --watch`, resets that socket (`ECONNRESET` or `EPIPE`). Both are normal and hidden; any other proxy error (such as the API being down) is still printed.

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

Data is stored in SQLite (`DB_PATH`, default `./data/app.db`; it holds webhook URLs and the proxy URL, so keep it private). The check interval is 10s to 24h (default 15s). The API only listens on 127.0.0.1.

The schema adapts itself: `PRAGMA user_version` records how far the file has been brought forward, and every step on start is idempotent. A database from any earlier release (including one from before versioning existed) is upgraded in place without losing data. Before an existing database is changed, a consistent copy is written next to it as `app.db-backup-v<from>-<timestamp>` (the newest 3 are kept). A database written by a newer version of the app is refused rather than damaged. To add a column or table, append a step to `MIGRATIONS` in `server/db.ts`; never edit a released step.

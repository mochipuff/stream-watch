# Stream Watch

Checks YouTube channels for upcoming and live streams and posts them to Discord webhooks (embed + "Watch on YouTube" button). Each video is sent once per webhook. Messages use the webhook's own name and avatar from Discord; the name typed in the dashboard is only a label. Thumbnails are `i.ytimg.com` `maxresdefault` URLs that Discord loads itself (falls back to `hqdefault` when YouTube has no max-res image). Streams listed under "Recently sent" can be sent again to the same webhook. A stream is announced once per webhook, whether it was first seen as upcoming or already live.

It is built to run on your own machine in dev mode: TypeScript everywhere, no build step, no paid server.

## Run

Requires Node 24 or newer (24 and 26 are both LTS; it runs `.ts` files directly and ships SQLite, so nothing native to compile). `npm run typecheck` uses TypeScript 7 (the native compiler, still the `tsc` command).

```bash
npm install
npm run dev
```

Open http://localhost:5173. On first run a random `ADMIN_TOKEN` is written to `.env` and printed; use it to log in. The API starts first on http://127.0.0.1:8787 and Vite starts once it answers. The database is created at `data/app.db` on API start.

Separate terminals also work once `.env` holds an `ADMIN_TOKEN` (run `npm run dev` once to create it): `npm run dev:server` and `npm run dev:web`. `npm run typecheck` checks server, shared code and dashboard together.

The poller lives in the API process, not in the browser: closing the dashboard tab never stops it. Closing the terminal that runs `npm run dev` does.

## How channels are checked

1. **RSS feed** (default, no key): the channel's `feeds/videos.xml` lists recent videos. YouTube sometimes answers this endpoint with a short-lived 404 or 5xx, so one retry follows, then the channel's live-streams playlist feed (`playlist_id=UULV…`) is tried before the check counts as failed. Each new video is classified as `live`, `upcoming` or plain from its watch page. Plain videos are remembered in the database and never loaded again; live and upcoming ones are re-read every 5 minutes.
2. **YouTube Data API v3** (fallback, needs `YOUTUBE_API_KEY` in `.env`): used only when the RSS path fails. It reads the uploads playlist and classifies the videos with `liveBroadcastContent`. The key is sent in a header, never in a URL. When the quota is used up, the API is paused for 1 hour.

The dashboard shows which source answered for each channel. The channel id (UC…) is resolved once and stored.

**Proxy**: set an `http://`, `https://`, `socks5://` or `socks5h://` proxy under "Sources and proxy". It applies to YouTube and Google requests only, not Discord. If the proxy fails, the request is retried directly (no proxy) and the proxy is skipped for 60 seconds. No proxy is the default. Note that a direct fallback shows this machine's own IP to YouTube.

**Automatic cycle and manual check**: automatic checks can be turned off. "Check now" (and "Check" on one channel) works either way, ignores the failure back-off, and still never sends the same stream to the same webhook twice. Manual checks are limited to one every 5 seconds.

**Channel list**: search by handle or name, filter by All / Active / Paused / Error, 10 per page. At most 500 channels.

**Activity log**: changes, checks, sends, source and proxy fallbacks, and errors. The newest 2000 entries are kept. Webhook tokens, proxy passwords and API keys are removed before anything is written.

## How it fits together

- `shared/contract.ts`: Zod schemas, limits and the API/WebSocket types. The server validates with it and the dashboard imports the same types.
- `server/`: Hono API (`api.ts`), YouTube sources (`youtube.ts`), proxy-aware fetch (`http.ts`), Discord sender (`discord.ts`), poller (`poller.ts`), audit log (`audit.ts`), events (`events.ts`), WebSocket pushes (`realtime.ts`), SQLite (`db.ts`).
- `web/`: React 19 dashboard. TanStack Query holds the data; the WebSocket and every API response write the same snapshot into it, so the page never refetches after an action. The activity log is paged from the server.
- `/api/*` JSON API: `overview`, `cycle`, `check`, `channels`, `channels/:id/check`, `webhooks`, `webhooks/:id/test`, `sent/:webhookId/:videoId/resend`, `settings` (`intervalMs`, `auto`, `proxyUrl`), `audit?level=&before=&limit=`, `ws-ticket`. Everything except `GET /api/health` needs `Authorization: Bearer <ADMIN_TOKEN>`.
  - `POST /api/check` and `POST /api/channels/:id/check` start a check and answer `202` at once with the snapshot (`cycle.running` is `true`). The result arrives as a `check_done` WebSocket event and in the audit log. They answer `409` while a check is running and `429` when called again within 5 seconds.
  - `GET /api/cycle` returns `{ auto, running, intervalMs, lastCycleAt, nextCycleAt }`.
- `/api/ws` realtime WebSocket on the same port. The dashboard gets a single-use ticket from `POST /api/ws-ticket`, so the token never appears in a URL.

Data is stored in SQLite (`DB_PATH`, default `./data/app.db`; it holds webhook URLs and the proxy URL, so keep it private). The check interval is 30s to 24h. The API only listens on 127.0.0.1 by default; keep it that way unless you add HTTPS in front. Older databases are upgraded automatically on start.

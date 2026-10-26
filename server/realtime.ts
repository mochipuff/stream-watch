import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { WsMessage } from "../shared/contract.ts";
import { hostAllowed, originAllowed } from "./config.ts";
import { overview } from "./overview.ts";
import { events } from "./events.ts";

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const MAX_SOCKETS = 10;

function broadcast(message: WsMessage) {
  const text = JSON.stringify(message);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(text);
}

events.on("stream_sent", (data) => broadcast({ type: "stream_sent", data }));
events.on("channel_error", (data) => broadcast({ type: "channel_error", data }));
events.on("check_done", (data) => broadcast({ type: "check_done", data }));
events.on("network", (data) => broadcast({ type: "network", data }));

// Several changes in a row (a cycle that sends to many webhooks) become one push instead of one each.
function coalesced(delayMs: number, push: () => void) {
  let timer: NodeJS.Timeout | undefined;
  return {
    trigger() {
      timer ??= setTimeout(() => {
        timer = undefined;
        if (wss.clients.size > 0) push();
      }, delayMs);
    },
    cancel: () => clearTimeout(timer),
  };
}

const overviewPush = coalesced(50, () => broadcast({ type: "overview", data: overview() }));
const auditPush = coalesced(250, () => broadcast({ type: "audit" }));
events.on("changed", overviewPush.trigger);
events.on("audit", auditPush.trigger);

const alive = new WeakSet<WebSocket>();
wss.on("connection", (ws) => {
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));
  ws.on("error", () => ws.terminate());
  ws.send(JSON.stringify({ type: "overview", data: overview() } satisfies WsMessage));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 20_000);
heartbeat.unref();

export function attachRealtime(server: Server) {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {}); // a reset socket after upgrade must not crash the process
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/ws") return reject(404, "Not Found");

    // No login: the Host and Origin checks are what keep other websites out.
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin, req.headers.host)) return reject(403, "Forbidden");
    if (wss.clients.size >= MAX_SOCKETS) return reject(503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}

export function closeRealtime() {
  overviewPush.cancel();
  auditPush.cancel();
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.terminate();
}

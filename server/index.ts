import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { HOST, PORT } from "./config.ts"; // first: validates the environment before anything opens the database
import { app } from "./api.ts";
import { DB_FILE, db } from "./db.ts";
import { startPoller, stopPoller } from "./poller.ts";
import { attachRealtime, closeRealtime } from "./realtime.ts";

process.on("unhandledRejection", (reason) => console.error("[api] unhandled rejection:", reason));
// A reset socket (browser closed, network blip) must never stop the poller. Only these known network
// codes are ignored. Anything else is a real bug: exit and let the dev script (or a supervisor) start a clean process.
const IGNORED_NET_ERRORS = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED"]);
process.on("uncaughtException", (err) => {
  const code = "code" in err ? String(err.code) : "";
  if (IGNORED_NET_ERRORS.has(code)) return console.error(`[api] ignored network error: ${code}`);
  console.error("[api] fatal:", err);
  process.exit(1);
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`[api] http://${HOST}:${PORT} (db: ${DB_FILE})`);
  startPoller();
}) as Server;

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `[api] Port ${PORT} is already in use. Stop the other process or change PORT in .env.` : `[api] ${err.message}`);
  process.exit(1);
});
attachRealtime(server);

function shutdown() {
  stopPoller();
  closeRealtime();
  server.closeAllConnections();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);

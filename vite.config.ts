import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, loadEnv } from "vite";

// Closing or reloading a tab, or the API restarting (node --watch), resets the proxied WebSocket: ECONNRESET when the
// read side breaks, EPIPE when Vite writes into a socket the other side has already closed. Both are normal, so Vite must
// not print them as errors. Every other proxy error (for example the API being down) is still logged.
const BENIGN_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE"]);
const logger = createLogger();
const logError = logger.error;
logger.error = (msg, options) => {
  const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code;
  if (code && BENIGN_SOCKET_CODES.has(code) && /ws proxy (socket )?error/.test(msg)) return;
  logError(msg, options);
};

export default defineConfig(({ mode }) => {
  // Follow the API's PORT/HOST from .env. 127.0.0.1 (not "localhost") avoids IPv6 ::1 resolution misses.
  const env = loadEnv(mode, process.cwd(), "");
  const host = env.HOST && !["0.0.0.0", "::"].includes(env.HOST) ? env.HOST : "127.0.0.1";
  return {
    customLogger: logger,
    plugins: [react(), tailwindcss()],
    // ws: true also proxies the realtime socket at /api/ws, so the browser only ever talks to this origin.
    server: { proxy: { "/api": { target: `http://${host}:${env.PORT || 8787}`, ws: true } } },
  };
});

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, loadEnv } from "vite";

// Closing or reloading a tab resets the proxied WebSocket (ECONNRESET). That is normal, so Vite must not
// print it as an error. Every other proxy error (for example the API being down) is still logged.
const logger = createLogger();
const logError = logger.error;
logger.error = (msg, options) => {
  const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === "ECONNRESET" && /ws proxy (socket )?error/.test(msg)) return;
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

// `npm run dev`: starts the API (node --watch), waits until it answers, then starts Vite.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error(`[dev] Node 24 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}

const VITE = "node_modules/vite/bin/vite.js";
if (!existsSync(VITE)) {
  console.error("[dev] Dependencies are missing. Run `npm install` first.");
  process.exit(1);
}

// Only HOST and PORT are needed here, to find the API. The server itself reads .env through --env-file-if-exists.
const env = { ...(existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {}), ...process.env };
const host = env.HOST && !["0.0.0.0", "::"].includes(env.HOST) ? env.HOST : "127.0.0.1";
const healthUrl = `http://${host}:${env.PORT || 8787}/api/health`;

const run = (args: string[]) => spawn(process.execPath, args, { stdio: "inherit" });
const children: ReturnType<typeof run>[] = [];
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(0));

async function waitForApi(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    try {
      if ((await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const api = run(["--watch", "--env-file-if-exists=.env", "--disable-warning=ExperimentalWarning", "server/index.ts"]);
children.push(api);
api.on("exit", (code) => stop(code ?? 0));

// Vite only serves the dashboard. If it stops, the API and its poller keep running and Vite is restarted.
let webRestarts = 0;
function startWeb() {
  const web = run([VITE]);
  const startedAt = Date.now();
  children.push(web);
  web.on("exit", (code) => {
    children.splice(children.indexOf(web), 1);
    if (stopping) return;
    if (Date.now() - startedAt > 60_000) webRestarts = 0;
    if (++webRestarts > 5) {
      console.error("[dev] Vite keeps stopping. The API is still running. Fix the error above, then run `npm run dev:web`.");
      return;
    }
    console.error(`[dev] Vite stopped (code ${code}). Restarting (${webRestarts}/5)...`);
    setTimeout(() => !stopping && startWeb(), 1000);
  });
}

if (await waitForApi()) {
  startWeb();
} else if (!stopping) {
  console.error(`[dev] The API did not answer at ${healthUrl}. Read the server error printed above, then run \`npm run dev\` again.`);
  stop(1);
}

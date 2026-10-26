import { setTimeout as sleep } from "node:timers/promises";
import { audit } from "./audit.ts";
import { events } from "./events.ts";

// One answer to "is this machine online?" for the whole server. A network failure does not flip it by itself: it starts a probe,
// and only repeated probe failures mean offline. Coming back needs several good probes in a row, so a flapping connection
// does not start (and abort) a check every second. While offline, no request to YouTube is made and no failure is counted.

const FAIL_LIMIT = 2; // failed probes in a row before the server calls itself offline
const STABLE_LIMIT = 3; // good probes in a row before it calls itself online again
const SUSPECT_GAP_MS = 500;
const OFFLINE_GAP_MS = 2000;

let online = true;
let probing = false;
let stopped = false;
let probe: () => Promise<boolean> = async () => true;
let waiting: (() => void)[] = [];

export const isOnline = () => online;

/** Installed by http.ts, so the probe takes the same route (proxy or direct) as the real requests. */
export function setProbe(fn: () => Promise<boolean>) {
  probe = fn;
}

function setOnline(next: boolean) {
  if (online === next) return;
  online = next;
  audit(next ? "info" : "warn", next ? "network.online" : "network.offline", next ? "Connection is back and stable. Checking again now." : "No internet connection. Checks are paused until it is back.");
  events.emit("network", { online });
  events.emit("changed");
  if (next) for (const resolve of waiting.splice(0)) resolve();
}

async function verify() {
  if (probing) return;
  probing = true;
  try {
    let bad = 0;
    let good = 0;
    while (!stopped) {
      const ok = await probe().catch(() => false);
      if (online) {
        if (ok) return; // the failure was local to one request
        if (++bad >= FAIL_LIMIT) setOnline(false);
      } else {
        good = ok ? good + 1 : 0;
        if (good >= STABLE_LIMIT) return setOnline(true);
      }
      await sleep(online ? SUSPECT_GAP_MS : OFFLINE_GAP_MS, undefined, { ref: false });
    }
  } finally {
    probing = false;
  }
}

/** A request failed in a way that may mean the connection is gone. Returns at once; the probe runs in the background. */
export function reportNetworkFailure() {
  if (online) void verify();
}

/** Resolves when the connection is back and stable. Resolves at once when it is online, and when `signal` aborts. */
export function waitUntilOnline(signal?: AbortSignal): Promise<void> {
  if (online || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal?.removeEventListener("abort", done);
      waiting = waiting.filter((w) => w !== done);
      resolve();
    };
    waiting.push(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function stopConnectivity() {
  stopped = true;
  for (const resolve of waiting.splice(0)) resolve();
}

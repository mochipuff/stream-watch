import { useEffect, useState } from "react";
import type { WsMessage } from "../shared/contract.ts";
import { AUDIT_KEY, ApiError, api, applyOverview, queryClient } from "./api.ts";
import { toast } from "./toast.ts";

function parse(data: unknown): WsMessage | null {
  try {
    return JSON.parse(String(data)) as WsMessage;
  } catch {
    return null;
  }
}

/**
 * Keeps one WebSocket open while the dashboard is mounted. Snapshots go straight into the query cache and
 * stream events become toasts. Returns whether the socket is currently connected.
 */
export function useRealtime(): boolean {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // `disposed` stops a late reconnect after the dashboard unmounts (Lock) or StrictMode remounts it.
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const reconnect = () => {
      if (!disposed) retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000));
    };

    async function connect() {
      let ticket: string;
      try {
        ({ ticket } = await api.ticket());
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) reconnect(); // 401 means the dashboard just locked
        return;
      }
      if (disposed) return;

      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${window.location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        const message = parse(event.data);
        if (!message) return;
        switch (message.type) {
          case "overview":
            applyOverview(message.data);
            break;
          case "audit":
            void queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
            break;
          case "check_done": {
            const { target, sent, failed } = message.data;
            const text = `${target}: ${sent} sent${failed ? `, ${failed} failed` : ""}`;
            if (failed) toast.error(text, "Check finished");
            else toast.success(text, "Check finished");
            break;
          }
          case "stream_sent":
            toast.success(
              `"${message.data.title}" (${message.data.handle}) was sent to "${message.data.webhookName}"`,
              "Stream sent",
            );
            break;
          case "channel_error":
            toast.error(`${message.data.handle}: ${message.data.error}`, "YouTube check failed");
            break;
        }
      };
      ws.onclose = () => {
        setConnected(false);
        reconnect();
      };
    }

    void connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      }
    };
  }, []);

  return connected;
}

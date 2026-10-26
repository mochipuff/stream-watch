import { EventEmitter } from "node:events";
import type { CheckDoneEvent, ChannelErrorEvent, NetworkEvent, StreamSentEvent } from "../shared/contract.ts";

// "changed" means the dashboard data may differ now; the realtime layer turns events into WebSocket pushes.
export const events = new EventEmitter<{
  stream_sent: [StreamSentEvent];
  channel_error: [ChannelErrorEvent];
  check_done: [CheckDoneEvent];
  network: [NetworkEvent];
  changed: [];
  audit: [];
}>();

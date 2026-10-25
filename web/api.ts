import { MutationCache, QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import type { AuditLevel, AuditPage, ChannelCreateInput, ChannelPatchInput, ManualVideoCreateInput, Overview, SettingsInput, WebhookCreateInput } from "../shared/contract.ts";
import { toast } from "./toast.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// Every change answers with the new Overview, so the cache is updated straight from the response.
export const api = {
  overview: () => request<Overview>("GET", "overview"),
  addChannel: (body: ChannelCreateInput) => request<Overview>("POST", "channels", body),
  patchChannel: (id: string, body: ChannelPatchInput) => request<Overview>("PATCH", `channels/${id}`, body),
  addVideo: (channelId: string, body: ManualVideoCreateInput) => request<Overview>("POST", `channels/${channelId}/videos`, body),
  removeVideo: (channelId: string, videoId: string) => request<Overview>("DELETE", `channels/${channelId}/videos/${videoId}`),
  removeChannel: (id: string) => request<Overview>("DELETE", `channels/${id}`),
  addWebhook: (body: WebhookCreateInput) => request<Overview>("POST", "webhooks", body),
  patchWebhook: (id: string, body: { enabled: boolean }) => request<Overview>("PATCH", `webhooks/${id}`, body),
  removeWebhook: (id: string) => request<Overview>("DELETE", `webhooks/${id}`),
  testWebhook: (id: string) => request<Overview>("POST", `webhooks/${id}/test`),
  resend: (webhookId: string, videoId: string) => request<Overview>("POST", `sent/${webhookId}/${videoId}/resend`),
  check: () => request<Overview>("POST", "check"),
  checkChannel: (id: string) => request<Overview>("POST", `channels/${id}/check`),
  saveSettings: (body: SettingsInput) => request<Overview>("PUT", "settings", body),
  audit: ({ level, before }: { level?: AuditLevel; before?: number }) => {
    const params = new URLSearchParams();
    if (level) params.set("level", level);
    if (before) params.set("before", String(before));
    return request<AuditPage>("GET", `audit?${params}`);
  },
};

export const OVERVIEW_KEY = ["overview"] as const;
export const AUDIT_KEY = ["audit"] as const;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000, // the WebSocket keeps the data fresh; a refetch only happens after it was down
      retry: 2,
    },
  },
  mutationCache: new MutationCache({
    onError: (err) => toast.error(err.message),
  }),
});

/** Takes a snapshot from a response or a push, unless a newer one is already stored (they can arrive out of order). */
export function applyOverview(next: Overview) {
  queryClient.setQueryData<Overview>(OVERVIEW_KEY, (current) => (current && current.rev > next.rev ? current : next));
}

export function useOverview() {
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api.overview() });
}

/** A button-triggered change. `success` is the toast text, or a function of the variables. */
export function useAction<V = void>(run: (variables: V) => Promise<Overview>, success?: string | ((variables: V) => string)) {
  return useMutation({
    mutationFn: run,
    onSuccess: (data, variables) => {
      applyOverview(data);
      if (success) toast.success(typeof success === "function" ? success(variables) : success);
    },
  });
}

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  title?: string;
  message: string;
}

// A tiny external store: any code can raise a toast, and only <ToastContainer> re-renders when one changes.
let toasts: readonly Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getToasts = () => toasts;

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(kind: ToastKind, message: string, title?: string) {
  const id = ++nextId;
  toasts = [...toasts.slice(-4), { id, kind, message, title }];
  emit();
  setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4500);
}

export const toast = {
  info: (message: string, title?: string) => push("info", message, title),
  success: (message: string, title?: string) => push("success", message, title),
  error: (message: string, title?: string) => push("error", message, title),
};

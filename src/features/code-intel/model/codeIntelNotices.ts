import { useSyncExternalStore } from "react";

/** Short messages from code intelligence (compile results, setup errors). */
export type Notice = { id: number; message: string; error: boolean };

let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function reportCodeIntel(
  message: string,
  error = true,
  ttlMs = error ? 8000 : 2500,
) {
  // Same message twice in a row: keep one.
  if (notices.some((n) => n.message === message)) return;
  const notice = { id: nextId++, message, error };
  notices = [...notices.slice(-3), notice];
  emit();
  window.setTimeout(() => dismissCodeIntel(notice.id), ttlMs);
}

export function dismissCodeIntel(id: number) {
  notices = notices.filter((n) => n.id !== id);
  emit();
}

export function useCodeIntelNotices(): Notice[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => notices,
    () => notices,
  );
}

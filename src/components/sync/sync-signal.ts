// The light half of sync that lives in the entry chunk: the flag that says
// "this device syncs" (so the engine is loaded only for people who use it)
// and the window events between the app and the lazily loaded controller.

/** Set while this device is connected; read at startup before anything heavy. */
export const SYNC_FLAG_KEY = "yuki-sync";

/** Fired by the controller after a round changed local data. */
export const SYNC_APPLIED_EVENT = "yuki:sync-applied";

export interface SyncAppliedDetail {
  books: boolean;
  settings: boolean;
  stats: boolean;
}

export function syncEnabled(): boolean {
  try {
    return localStorage.getItem(SYNC_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSyncEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(SYNC_FLAG_KEY, "1");
    else localStorage.removeItem(SYNC_FLAG_KEY);
  } catch {
    // storage may be unavailable
  }
}

/** True when the page was opened by a provider's OAuth redirect. */
export function isAuthRedirect(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("state") && (params.has("code") || params.has("error"));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function onSyncApplied(listener: (detail: SyncAppliedDetail) => void): () => void {
  const handler = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if (!isRecord(detail)) return;
    listener({ books: detail.books === true, settings: detail.settings === true, stats: detail.stats === true });
  };
  window.addEventListener(SYNC_APPLIED_EVENT, handler);
  return () => window.removeEventListener(SYNC_APPLIED_EVENT, handler);
}

export function emitSyncApplied(detail: SyncAppliedDetail): void {
  window.dispatchEvent(new CustomEvent(SYNC_APPLIED_EVENT, { detail }));
}

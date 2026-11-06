import { syncRound, type RoundProgress } from "@/core/sync/engine";
import type { DeviceInfo, DeviceState } from "@/core/sync/model";
import { TokenKeeper } from "@/core/sync/oauth";
import { AuthRequiredError, QuotaError, type ProviderKind, type RemoteFolder } from "@/core/sync/remote";
import type { PackDesc } from "@/core/sync/book-pack";
import type { BookKey } from "@/core/sync/model";
import { syncStore, type SyncStatus } from "@/core/sync/store";
import { inspectVault, VaultError, VAULT_PATH, RECOVERY_SLOT_PATH, type VaultErrorCode } from "@/core/sync/vault";
import type { DirectStage } from "./p2p";
import { createBridge, type SyncHost } from "./sync-bridge";
import { initNearby, nearbyEnabled, nearbyExchange, nearbyMode } from "./sync-nearby";
import { CLIENT_IDS, describeDevice, PROVIDERS } from "./sync-config";
import { afterSignIn, forgetCloud } from "./sync-auth";
export { connect, completeRedirect, pasteCode, recheck, unlock, confirmKeySaved } from "./sync-auth";
import { emitSyncApplied, setSyncEnabled } from "./sync-signal";

// The sync controller: connection state machine, scheduling and the actions
// the Settings group offers. Loaded lazily — only on devices that sync, on
// an OAuth return, or when Settings opens. One round at a time per origin
// (Web Locks); errors never interrupt reading, they only show in Settings.

export type SyncPhase =
  | { kind: "off" }
  | { kind: "authorizing"; provider: ProviderKind }
  | { kind: "foreignCode"; code: string }
  | { kind: "locked"; provider: ProviderKind; error?: VaultErrorCode }
  | { kind: "newKey"; provider: ProviderKind; recoveryKey: string }
  | { kind: "ready"; provider: ProviderKind }
  | { kind: "damaged"; provider: ProviderKind };

export interface SyncView {
  phase: SyncPhase;
  syncing: boolean;
  /** The running round, step by step (undefined between rounds). */
  round?: RoundProgress;
  status?: SyncStatus;
  heldDeletions: string[];
  devices: { info: DeviceInfo; self: boolean }[];
  /** The pre-sync snapshot exists ("undo the first sync" for 7 days). */
  snapshotAt?: number;
  /** Last sign-in attempt failed. */
  signInFailed?: boolean;
  /** Books another device holds that this one doesn't (sync-cloud.ts):
      in the cloud, or — with `from` — only on that device. `preparing`:
      still being processed there (0..1 done) — not downloadable yet. */
  cloud: { key: BookKey; desc: PackDesc; from?: DeviceInfo; preparing?: number }[];
  /** Downloads in flight: content key → 0..1. */
  downloads: Record<BookKey, number>;
  /** Direct transfers before their first byte: ringing, closed, connecting. */
  direct: Record<BookKey, DirectStage>;
  /** Local ids whose files are in the cloud — "remove from this device". */
  inCloud: string[];
  /** Book uploads under way: content key → title and 0..1 in the cloud.
      Kept between rounds while an upload carries on in the next one. */
  uploads: Record<BookKey, { title: string; progress: number }>;
}

let view: SyncView = { phase: { kind: "off" }, syncing: false, heldDeletions: [], devices: [], cloud: [], downloads: {}, direct: {}, inCloud: [], uploads: {} };
const roundListeners = new Set<() => Promise<void>>();
const listeners = new Set<() => void>();
let host: SyncHost | null = null;
let remotesCache: DeviceState[] = [];
let rerun = false;
let running = false;
let forceCloud = false;
let timer = 0;
let triggersOn = false;
let cloudAbort: AbortController | undefined;
let lastCloudRound = 0;

/** sync-cloud.ts hooks in here: it runs after every successful round. */
export function onRoundDone(listener: () => Promise<void>): void {
  roundListeners.add(listener);
}

export const currentHost = (): SyncHost | null => host;
/** Other devices' states from the last round. */
export const remotes = (): DeviceState[] => remotesCache;

export function patchView(patch: Partial<SyncView>): void {
  setView(patch);
}

function setView(patch: Partial<SyncView>): void {
  view = { ...view, ...patch };
  for (const listener of listeners) listener();
}

export const getView = (): SyncView => view;
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function attachHost(next: SyncHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

export async function device(): Promise<DeviceInfo> {
  const known = await syncStore.device();
  const info = describeDevice(known?.id ?? crypto.randomUUID().replace(/-/g, ""));
  if (!known || known.platform !== info.platform || known.app !== info.app) await syncStore.setDevice(info);
  return info;
}

export async function folder(signal?: AbortSignal): Promise<RemoteFolder | null> {
  const session = await syncStore.session();
  if (!session) return null;
  const auth = PROVIDERS[session.kind];
  const fetchImpl = (input: string, init?: RequestInit) =>
    fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) });
  const keeper = new TokenKeeper(session, auth, CLIENT_IDS[session.kind], (s) => syncStore.setSession(s), fetchImpl);
  return auth.folder(keeper, fetchImpl);
}

async function refreshDevices(remotes: DeviceState[]): Promise<void> {
  remotesCache = remotes;
  const self = await device();
  setView({
    devices: [{ info: self, self: true }, ...remotes.map((r) => ({ info: r.device, self: false }))],
  });
}

/** Restore the connection state at startup. */
export async function init(): Promise<void> {
  await initNearby();
  const [session, vault, pending, recovery, status, snapshot] = await Promise.all([
    syncStore.session(),
    syncStore.vault(),
    syncStore.pendingAuth(),
    syncStore.recoveryToShow(),
    syncStore.status(),
    syncStore.snapshot(),
  ]);
  const phase: SyncPhase = session && vault
    ? recovery
      ? { kind: "newKey", provider: session.kind, recoveryKey: recovery }
      : { kind: "ready", provider: session.kind }
    : session
      ? { kind: "locked", provider: session.kind }
      : pending
        ? { kind: "authorizing", provider: pending.kind }
        : { kind: "off" };
  setView({ phase, status, snapshotAt: snapshot?.at });
  remotesCache = (await syncStore.remotes()).map((r) => r.state);
  if (vault) await refreshDevices(remotesCache);
}

function errorOf(error: unknown): NonNullable<SyncStatus["error"]> {
  if (error instanceof AuthRequiredError) return "auth";
  if (error instanceof QuotaError) return "quota";
  if (error instanceof VaultError) return "vault";
  if (error instanceof TypeError) return "network";
  return "unknown";
}

async function round(peerOnly = false): Promise<void> {
  if (!host?.ready()) return;
  const abort = new AbortController();
  const [remote, vault, session] = await Promise.all([peerOnly ? null : folder(abort.signal), syncStore.vault(), syncStore.session()]);
  if (!peerOnly && (!remote || !vault || !session)) return;
  if (!peerOnly) cloudAbort = abort;
  if (!peerOnly) setView({ syncing: true });
  try {
    if (remote && vault && session) {
      const found = await inspectVault(remote);
      if (found.kind !== "vault" || found.vault.id !== vault.id) {
        // Recreated from another device (or damaged): stop and ask. Nothing
        // local is dropped here — a provider hiccup must not cost anything;
        // unlocking the new vault is what resets this device's sync memory.
        setView({ phase: found.kind === "vault" ? { kind: "locked", provider: session.kind, error: "changed" } : { kind: "damaged", provider: session.kind } });
        return;
      }
    }
    const report = await syncRound({
      remote,
      store: syncStore,
      vault: vault ?? null,
      ...(nearbyEnabled() ? { peer: nearbyExchange, joinMode: nearbyMode() } : {}),
      device: await device(),
      bridge: await createBridge(host),
      filesDeadline: Date.now() + FILES_BUDGET_MS,
      onProgress: peerOnly ? undefined : (progress) => setView({ round: progress }),
      onUpload: (key, title, sent, total) => {
        const uploads = { ...view.uploads };
        if (total > 0 && sent >= total) delete uploads[key];
        else uploads[key] = { title, progress: total > 0 ? sent / total : 0 };
        setView({ uploads });
      },
    });
    const status: SyncStatus = {
      at: Date.now(),
      ok: true,
      sent: report.sent,
      received: report.received,
      bytes: report.bytes,
      heldDeletions: report.heldDeletions,
      ...(report.filesFull ? { full: true } : {}),
    };
    if (!peerOnly) {
      await syncStore.setStatus(status);
      setView({ status });
    }
    setView({ heldDeletions: report.heldDeletions, snapshotAt: (await syncStore.snapshot())?.at });
    await refreshDevices(report.remotes);
    emitSyncApplied({ books: report.received > 0, settings: report.received > 0, stats: true });
    for (const listener of roundListeners) await listener();
    // A book upload ran out of budget: carry on shortly, not in a minute.
    if (report.filesPending) rerun = true;
    else if (!peerOnly) setView({ uploads: {} });
  } catch (error) {
    if (abort.signal.aborted || peerOnly) return;
    const status: SyncStatus = { at: Date.now(), ok: false, sent: 0, received: 0, bytes: 0, error: errorOf(error), heldDeletions: view.heldDeletions };
    await syncStore.setStatus(status);
    setView({ status, uploads: {} });
  } finally {
    if (cloudAbort === abort) cloudAbort = undefined;
    if (!peerOnly) setView({ syncing: false, round: undefined });
  }
}

/** Book uploads per round stop between parts after this long, so a 300 MB
    volume never holds the reading state back; the next round resumes. */
const FILES_BUDGET_MS = 45_000;

/** One round now (queued behind a running one). */
export async function syncNow(manual = false): Promise<void> {
  if (view.phase.kind !== "ready" && !nearbyEnabled()) return;
  forceCloud ||= manual;
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  const run = async () => {
    if (nearbyEnabled()) await round(true);
    if (view.phase.kind === "ready" && (forceCloud || !nearbyEnabled() || Date.now() - lastCloudRound >= 60_000)) {
      forceCloud = false;
      lastCloudRound = Date.now();
      await round();
    }
  };
  try {
    if (navigator.locks) await navigator.locks.request("yuki-sync", run);
    else await run();
  } finally { running = false; }
  if (rerun) {
    rerun = false;
    void syncNow();
  }
}

/** Soon, not now: edits come in bursts while reading. */
export function requestSync(delayMs = 10_000): void {
  if (nearbyEnabled()) {
    delayMs = Math.min(delayMs, 750);
    if (delayMs <= 100) cloudAbort?.abort();
  }
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), delayMs);
}

/** iOS has no background sync: rounds run on open, on return to the app
    (after a beat — an iOS 18 bug fails requests fired the instant the app
    becomes visible), when the network returns, and every minute while open. */
export function startTriggers(): void {
  if (triggersOn) return;
  triggersOn = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestSync(1_200);
    else void syncNow();
  });
  window.addEventListener("online", () => requestSync(1_000));
  window.setInterval(() => {
    if (document.visibilityState === "visible") void syncNow();
  }, 60_000);
}

export async function disconnect(): Promise<void> {
  window.clearTimeout(timer);
  cloudAbort?.abort();
  const run = async () => {
    if (nearbyEnabled()) await forgetCloud();
    else await syncStore.clear();
  };
  if (navigator.locks) await navigator.locks.request("yuki-sync", run);
  else await run();
  setSyncEnabled(nearbyEnabled());
  if (!nearbyEnabled()) remotesCache = [];
  setView({ phase: { kind: "off" }, devices: [], status: undefined, heldDeletions: [], snapshotAt: undefined, cloud: [], downloads: {}, direct: {}, inCloud: [], uploads: {} });
  if (nearbyEnabled()) requestSync(0);
}

/** Lost recovery key: wipe the unreadable cloud copy and make a new vault
    from this device. Other devices will ask for the new key. */
export async function startOver(): Promise<void> {
  const remote = await folder();
  const session = await syncStore.session();
  if (!remote || !session) return;
  for (const entry of await remote.list("devices")) await remote.remove(entry.path);
  await remote.remove(RECOVERY_SLOT_PATH);
  await remote.remove(VAULT_PATH);
  await syncStore.resetVaultData();
  remotesCache = [];
  await afterSignIn(session.kind);
}

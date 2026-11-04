import { syncRound } from "@/core/sync/engine";
import { Hlc } from "@/core/sync/hlc";
import { furthestElsewhere } from "@/core/sync/merge";
import { writeSyncedSettings } from "@/core/sync/local";
import type { DeviceInfo, DeviceState } from "@/core/sync/model";
import { newState, pkcePair, postTokenForm, TokenKeeper } from "@/core/sync/oauth";
import { AuthRequiredError, QuotaError, type ProviderKind, type RemoteFolder } from "@/core/sync/remote";
import { syncStore, type SyncStatus } from "@/core/sync/store";
import { createVault, inspectVault, unlockVault, VaultError, VAULT_PATH, RECOVERY_SLOT_PATH, type VaultErrorCode } from "@/core/sync/vault";
import { createBridge, writePatches, type SyncHost } from "./sync-bridge";
import { CLIENT_IDS, describeDevice, PROVIDERS, redirectUri } from "./sync-config";
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
  status?: SyncStatus;
  devices: { info: DeviceInfo; self: boolean }[];
  /** The pre-sync snapshot exists ("undo the first sync" for 7 days). */
  snapshotAt?: number;
  /** Last sign-in attempt failed. */
  signInFailed?: boolean;
}

let view: SyncView = { phase: { kind: "off" }, syncing: false, devices: [] };
const listeners = new Set<() => void>();
let host: SyncHost | null = null;
let remotesCache: DeviceState[] = [];
let rerun = false;
let timer = 0;
let triggersOn = false;

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

async function device(): Promise<DeviceInfo> {
  const known = await syncStore.device();
  const info = describeDevice(known?.id ?? crypto.randomUUID().replace(/-/g, ""));
  if (!known || known.platform !== info.platform || known.app !== info.app) await syncStore.setDevice(info);
  return info;
}

async function folder(): Promise<RemoteFolder | null> {
  const session = await syncStore.session();
  if (!session) return null;
  const auth = PROVIDERS[session.kind];
  const fetchImpl = (input: string, init?: RequestInit) => fetch(input, init);
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

/** Leave for the provider's consent page (same window: popups break in
    home-screen apps and under COOP). */
export async function connect(kind: ProviderKind): Promise<void> {
  const { verifier, challenge } = await pkcePair();
  const state = newState();
  await syncStore.setPendingAuth({ kind, state, verifier, createdAt: Date.now() });
  setView({ phase: { kind: "authorizing", provider: kind }, signInFailed: false });
  window.location.assign(
    PROVIDERS[kind].authorizeUrl({ clientId: CLIENT_IDS[kind], challenge, state, redirectUri: redirectUri() }),
  );
}

async function exchange(code: string): Promise<boolean> {
  const pending = await syncStore.pendingAuth();
  if (!pending) return false;
  const auth = PROVIDERS[pending.kind];
  try {
    const session = await postTokenForm(
      auth.tokenUrl,
      auth.exchangeForm({ clientId: CLIENT_IDS[pending.kind], code, verifier: pending.verifier, redirectUri: redirectUri() }),
      (input, init) => fetch(input, init),
      undefined,
      pending.kind,
    );
    await syncStore.setSession(session);
    await syncStore.setPendingAuth(null);
    setSyncEnabled(true);
    await afterSignIn(pending.kind);
    return true;
  } catch {
    setView({ signInFailed: true });
    return false;
  }
}

/** The page was opened by a provider redirect. When this storage holds the
    matching verifier, finish here; otherwise (iOS can return into a Safari
    sheet whose storage the home-screen app never sees) show the code so the
    user can paste it into the app — useless without the app's verifier. */
export async function completeRedirect(search: string): Promise<void> {
  const params = new URLSearchParams(search);
  const code = params.get("code");
  const pending = await syncStore.pendingAuth();
  if (!code) {
    await syncStore.setPendingAuth(null);
    setView({ phase: { kind: "off" }, signInFailed: params.has("error") });
    return;
  }
  if (pending && pending.state === params.get("state")) await exchange(code);
  else setView({ phase: { kind: "foreignCode", code } });
}

export const pasteCode = (code: string): Promise<boolean> => exchange(code.trim());

async function afterSignIn(kind: ProviderKind): Promise<void> {
  const remote = await folder();
  if (!remote) return;
  const vault = await syncStore.vault();
  if (vault) {
    setView({ phase: { kind: "ready", provider: kind } });
    void syncNow();
    return;
  }
  const found = await inspectVault(remote);
  if (found.kind === "vault") {
    setView({ phase: { kind: "locked", provider: kind } });
  } else if (found.kind === "damaged") {
    setView({ phase: { kind: "damaged", provider: kind } });
  } else {
    const created = await createVault(remote);
    await syncStore.setVault(created.binding);
    await syncStore.setRecoveryToShow(created.recoveryKey);
    setView({ phase: { kind: "newKey", provider: kind, recoveryKey: created.recoveryKey } });
  }
}

/** "Check again" after a damaged-looking folder: inspect it once more. */
export async function recheck(): Promise<void> {
  const session = await syncStore.session();
  if (session) await afterSignIn(session.kind);
}

export async function unlock(text: string): Promise<boolean> {
  const remote = await folder();
  const session = await syncStore.session();
  if (!remote || !session) return false;
  try {
    const opened = await unlockVault(remote, text);
    const previous = await syncStore.vault();
    // A different vault than before (recreated elsewhere): start this
    // device's sync memory over as a joiner of the new one.
    if (previous && previous.id !== opened.id) await syncStore.resetVaultData();
    await syncStore.setVault(opened);
  } catch (error) {
    const code: VaultErrorCode = error instanceof VaultError ? error.code : "damaged";
    setView({ phase: { kind: "locked", provider: session.kind, error: code } });
    return false;
  }
  setView({ phase: { kind: "ready", provider: session.kind } });
  void syncNow();
  return true;
}

export async function confirmKeySaved(): Promise<void> {
  const session = await syncStore.session();
  await syncStore.setRecoveryToShow(null);
  if (session) setView({ phase: { kind: "ready", provider: session.kind } });
  void syncNow();
}

function errorOf(error: unknown): NonNullable<SyncStatus["error"]> {
  if (error instanceof AuthRequiredError) return "auth";
  if (error instanceof QuotaError) return "quota";
  if (error instanceof VaultError) return "vault";
  if (error instanceof TypeError) return "network";
  return "unknown";
}

async function round(): Promise<void> {
  const [remote, vault, session] = await Promise.all([folder(), syncStore.vault(), syncStore.session()]);
  if (!remote || !vault || !session || !host?.ready()) return;
  setView({ syncing: true });
  try {
    const found = await inspectVault(remote);
    if (found.kind !== "vault" || found.vault.id !== vault.id) {
      // Recreated from another device (or damaged): stop and ask. Nothing
      // local is dropped here — a provider hiccup must not cost anything;
      // unlocking the new vault is what resets this device's sync memory.
      setView({ phase: found.kind === "vault" ? { kind: "locked", provider: session.kind, error: "changed" } : { kind: "damaged", provider: session.kind } });
      return;
    }
    const report = await syncRound({ remote, store: syncStore, vault, device: await device(), bridge: await createBridge(host) });
    const status: SyncStatus = { at: Date.now(), ok: true, sent: report.sent, received: report.received, bytes: report.bytes, heldDeletions: report.heldDeletions };
    await syncStore.setStatus(status);
    setView({ status, snapshotAt: (await syncStore.snapshot())?.at });
    await refreshDevices(report.remotes);
    emitSyncApplied({ books: report.received > 0, settings: report.received > 0, stats: true });
  } catch (error) {
    const previous = view.status;
    const status: SyncStatus = { at: Date.now(), ok: false, sent: 0, received: 0, bytes: 0, error: errorOf(error), heldDeletions: previous?.heldDeletions ?? [] };
    await syncStore.setStatus(status);
    setView({ status });
  } finally {
    setView({ syncing: false });
  }
}

/** One round now (queued behind a running one). */
export async function syncNow(): Promise<void> {
  if (view.phase.kind !== "ready") return;
  if (view.syncing) {
    rerun = true;
    return;
  }
  const run = () => round();
  if (navigator.locks) await navigator.locks.request("yuki-sync", run);
  else await run();
  if (rerun) {
    rerun = false;
    void syncNow();
  }
}

/** Soon, not now: edits come in bursts while reading. */
export function requestSync(delayMs = 10_000): void {
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
  await syncStore.clear();
  setSyncEnabled(false);
  remotesCache = [];
  setView({ phase: { kind: "off" }, devices: [], status: undefined, snapshotAt: undefined });
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

/** Put back what the first sync overwrote; the values become fresh edits. */
export async function undoFirstSync(): Promise<void> {
  const snapshot = await syncStore.snapshot();
  if (!snapshot || !host) return;
  const current = new Map(host.books().map((book) => [book.id, book]));
  const patches = snapshot.books
    .filter((book) => current.has(book.id))
    .map((book) => ({
      id: book.id,
      key: "",
      progress: book.progress,
      lastReadAt: book.lastReadAt,
      favorite: book.favorite,
      title: book.title,
      series: book.series ?? null,
      volumeIndex: book.volumeIndex ?? null,
    }));
  await writePatches(patches, current);
  host.patch(patches);
  const keys = await syncStore.bookKeys();
  host.settingsApplied(writeSyncedSettings(snapshot.settings, (key) => [...keys].find(([, k]) => k === key)?.[0]));
  await syncStore.setSnapshot(null);
  setView({ snapshotAt: undefined });
  requestSync(0);
}

/** Answer the mass-deletion guard. */
export async function resolveHeldDeletions(remove: boolean): Promise<void> {
  const ids = view.status?.heldDeletions ?? [];
  if (ids.length === 0) return;
  if (remove) {
    host?.remove(ids);
  } else {
    // Keep them: stamp presence, which wins over the tombstones everywhere.
    const [shadow, keys, self] = await Promise.all([syncStore.shadow(), syncStore.bookKeys(), device()]);
    const hlc = new Hlc(await syncStore.hlc());
    if (shadow) {
      for (const id of ids) {
        const key = keys.get(id);
        const regs = key ? shadow.books[key] : undefined;
        if (key && regs) shadow.books[key] = { ...regs, deleted: { v: false, t: hlc.now(), d: self.id } };
      }
      await syncStore.setShadow(shadow);
      await syncStore.setHlc(hlc.value);
    }
  }
  if (view.status) setView({ status: { ...view.status, heldDeletions: [] } });
  requestSync(0);
}

/** "Continue from 45% · iPhone": the furthest place another device read. */
export async function offerFor(bookId: string, progress: number): Promise<{ p: number; device: DeviceInfo } | undefined> {
  const key = (await syncStore.bookKeys()).get(bookId);
  if (!key) return undefined;
  const best = furthestElsewhere(remotesCache, key, progress);
  return best ? { p: best.p, device: best.device } : undefined;
}

/** Move a book's stored position (the offer's action). */
export async function jumpTo(bookId: string, progress: number): Promise<void> {
  if (!host) return;
  const current = new Map(host.books().map((book) => [book.id, book]));
  const patch = { id: bookId, key: "", progress, lastReadAt: Date.now() };
  await writePatches([patch], current);
  host.patch([patch]);
  requestSync();
}

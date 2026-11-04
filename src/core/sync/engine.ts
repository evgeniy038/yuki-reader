import type { DailyStats } from "../stats";
import { sealJson, unsealJson } from "./crypto";
import { Hlc } from "./hlc";
import {
  canonical,
  emptyShadow,
  mergeStates,
  planLocal,
  reviveBooks,
  stampLocalEdits,
  type LocalPlan,
  type LocalState,
  type Shadow,
} from "./merge";
import {
  parseDeviceState,
  parseMonthStats,
  type BookKey,
  type DeviceInfo,
  type DeviceState,
  type MonthStats,
} from "./model";
import { syncOcr, type OcrBridge } from "./ocr-sync";
import type { RemoteEntry, RemoteFolder } from "./remote";
import type { PreSyncSnapshot, SyncStore, VaultBinding } from "./store";

// One sync round — pull before push, always:
//   1. list devices/ and download only files whose revision changed;
//      every file is decrypted, shape-checked, bound to this vault and to
//      its device, and a lower seq than already seen is a rollback → ignored.
//      A file that fails is "unknown": the last good copy stays in use;
//   2. stamp local edits, merge, plan, hand the plan to the app;
//   3. publish this device's state (only when something changed) and its
//      own stats months (only the months whose content changed).
// The engine never deletes anything in the cloud and never treats a missing
// file as "empty".

/** The app side of a round: what the library looks like, how to change it. */
export interface LocalBridge extends OcrBridge {
  /** Lean shelf state; books whose content key isn't known yet are left out. */
  snapshot(): Promise<LocalState>;
  apply(plan: LocalPlan, basis: LocalState): Promise<void>;
  /** This device's own reading days (per-book slices under LOCAL ids). */
  localStats(): Promise<DailyStats[]>;
  /** Local id → content key, for the stats this device publishes. */
  keyOf(localId: string): BookKey | undefined;
}

export interface EngineContext {
  remote: RemoteFolder;
  store: SyncStore;
  vault: VaultBinding;
  device: DeviceInfo;
  bridge: LocalBridge;
}

export interface RoundReport {
  sent: number;
  received: number;
  bytes: number;
  heldDeletions: string[];
  /** Other devices' current states — for the device list and the offers. */
  remotes: DeviceState[];
}

const STATE = /^devices\/([^/]+)\/state\.bin$/;
const STATS = /^devices\/([^/]+)\/stats\/(\d{4}-\d{2})\.bin$/;

export const statePath = (deviceId: string): string => `devices/${deviceId}/state.bin`;
export const statsPath = (deviceId: string, month: string): string =>
  `devices/${deviceId}/stats/${month}.bin`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This device's days, grouped by month, per-book slices under content keys. */
export function monthsOf(days: DailyStats[], keyOf: (id: string) => BookKey | undefined): Map<string, MonthStats> {
  const months = new Map<string, MonthStats>();
  for (const day of days) {
    if (day.chars + day.pages + day.timeMs <= 0) continue;
    const month = day.date.slice(0, 7);
    const perBook: Record<BookKey, { chars: number; pages: number; timeMs: number }> = {};
    for (const [id, slice] of Object.entries(day.perBook ?? {})) {
      const key = keyOf(id);
      if (key) perBook[key] = { chars: slice.chars, pages: slice.pages, timeMs: slice.timeMs };
    }
    const entry = months.get(month) ?? {};
    entry[day.date] = { chars: day.chars, pages: day.pages, timeMs: day.timeMs, perBook };
    months.set(month, entry);
  }
  return months;
}

function preSyncSnapshot(local: LocalState): PreSyncSnapshot {
  return {
    at: Date.now(),
    books: local.books.map((book) => ({
      id: book.id,
      progress: book.progress,
      title: book.title,
      favorite: book.favorite,
      ...(book.lastReadAt !== undefined ? { lastReadAt: book.lastReadAt } : {}),
      ...(book.series !== undefined ? { series: book.series } : {}),
      ...(book.volumeIndex !== undefined ? { volumeIndex: book.volumeIndex } : {}),
    })),
    settings: { ...local.settings },
  };
}

function changedRegisters(before: Shadow, after: Pick<Shadow, "books" | "settings">): number {
  let count = 0;
  for (const [key, regs] of Object.entries(after.books)) {
    if (canonical({ ...regs, own: undefined }) !== canonical({ ...before.books[key], own: undefined })) count += 1;
  }
  for (const [key, reg] of Object.entries(after.settings)) {
    if (canonical(reg) !== canonical(before.settings[key])) count += 1;
  }
  return count;
}

export async function syncRound(ctx: EngineContext): Promise<RoundReport> {
  const { remote, store, vault, device, bridge } = ctx;
  const hlc = new Hlc(await store.hlc());
  let bytes = 0;

  // 1. Pull.
  const entries: RemoteEntry[] = await remote.list("devices");
  const remotes = new Map((await store.remotes()).map((r) => [r.state.device.id, r]));
  const remoteStats = await store.remoteStats();
  for (const entry of entries) {
    const state = STATE.exec(entry.path);
    if (state) {
      const id = state[1]!;
      const known = remotes.get(id);
      if (id === device.id || known?.rev === entry.rev) continue;
      const sealed = await remote.read(entry.path);
      if (!sealed) continue;
      bytes += sealed.length;
      const parsed = await unsealJson(vault.keys, vault.id, entry.path, sealed).then(parseDeviceState, () => undefined);
      if (!parsed || parsed.vault !== vault.id || parsed.device.id !== id) continue;
      if (known && parsed.seq < known.state.seq) continue;
      remotes.set(id, { state: parsed, rev: entry.rev });
      continue;
    }
    const stats = STATS.exec(entry.path);
    if (!stats || stats[1] === device.id) continue;
    const slot = `${stats[1]}/${stats[2]}`;
    if (remoteStats.get(slot)?.rev === entry.rev) continue;
    const sealed = await remote.read(entry.path);
    if (!sealed) continue;
    bytes += sealed.length;
    const days = await unsealJson(vault.keys, vault.id, entry.path, sealed).then(parseMonthStats, () => undefined);
    if (days) remoteStats.set(slot, { days, rev: entry.rev });
  }

  // 2. Merge.
  const stored = await store.shadow();
  const shadow = stored ?? emptyShadow();
  const local = await bridge.snapshot();
  if (!stored && !(await store.snapshot())) await store.setSnapshot(preSyncSnapshot(local));
  if ((await store.joinedAt()) === undefined) await store.setJoinedAt(Date.now());
  // An EMPTY library is "unknown", not "everything was deleted": a shelf
  // that hasn't loaded, a wiped storage or a fresh install must never send
  // tombstones for the whole library (Anx Reader wiped libraries this way).
  const basis = local.books.length === 0 ? { ...shadow, held: [] } : shadow;
  const self = stampLocalEdits(basis, local, hlc, device.id, vault.mode);
  const remoteStates = [...remotes.values()].map((r) => r.state);
  const merged = mergeStates(self, remoteStates, hlc);
  const plan = planLocal(merged, local, shadow.held);
  reviveBooks(merged, plan.revive, hlc, device.id);
  await bridge.apply(plan, local);
  const removed = new Set(plan.deletions.map((d) => d.key));
  const held = [...new Set(local.books.map((b) => b.key).filter((k) => !removed.has(k)))];
  const sent = changedRegisters(shadow, self);
  const ocrApplied = await store.ocrApplied();
  bytes += await syncOcr(remote, vault, device, bridge, merged, local, hlc, ocrApplied);

  // 3. Push.
  const body = { books: merged.books, settings: merged.settings };
  const hash = await sha256Hex(canonical(body));
  const published = await store.published();
  if (hash !== published.hash) {
    const next: DeviceState = { v: 1, vault: vault.id, seq: published.seq + 1, device, ...body };
    const path = statePath(device.id);
    const sealed = await sealJson(vault.keys, vault.id, path, next);
    await remote.write(path, sealed);
    bytes += sealed.length;
    await store.setPublished({ seq: next.seq, hash });
  }
  const months = monthsOf(await bridge.localStats(), (id) => bridge.keyOf(id));
  const publishedStats = await store.publishedStats();
  for (const [month, days] of months) {
    const monthHash = await sha256Hex(canonical(days));
    if (publishedStats[month] === monthHash) continue;
    const path = statsPath(device.id, month);
    const sealed = await sealJson(vault.keys, vault.id, path, days);
    await remote.write(path, sealed);
    bytes += sealed.length;
    publishedStats[month] = monthHash;
  }

  await store.setShadow({ books: merged.books, settings: merged.settings, held });
  await store.setRemotes([...remotes.values()]);
  await store.setRemoteStats(remoteStats);
  await store.setPublishedStats(publishedStats);
  await store.setOcrApplied(ocrApplied);
  await store.setHlc(hlc.value);
  return {
    sent,
    received: plan.patches.length + plan.deletions.length + Object.keys(plan.settings).length,
    bytes,
    heldDeletions: plan.heldDeletions.map((d) => d.id),
    remotes: remoteStates,
  };
}

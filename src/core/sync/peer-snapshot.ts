import { parseCatalog, type Catalog } from "./catalog";
import { emptyShadow, mergeStates } from "./merge";
import { parseDeviceState, parseMonthStats, type DeviceState, type MonthStats } from "./model";
import type { Hlc } from "./hlc";
import type { SyncStore } from "./store";

/** Plain metadata travels only inside an authenticated WebRTC channel.
    Cloud file references and cloud keys never cross this boundary. */
export interface PeerSnapshot {
  v: 1;
  state: DeviceState;
  stats: Record<string, MonthStats>;
  catalog: Catalog;
}

export interface PeerExchange {
  snapshots(): PeerSnapshot[];
  publish(snapshot: PeerSnapshot): Promise<void>;
}

export function parsePeerSnapshot(value: unknown): PeerSnapshot | undefined {
  if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1 ||
      !("state" in value) || !("catalog" in value) || !("stats" in value)) return;
  const state = parseDeviceState(value.state);
  const catalog = parseCatalog(value.catalog);
  const stats = parseStats(value.stats);
  if (!state || !catalog || !stats) return;
  return { v: 1, state: portableState(state), catalog, stats };
}

function parseStats(value: unknown): PeerSnapshot["stats"] | undefined {
  if (typeof value !== "object" || value === null) return;
  const stats: Record<string, MonthStats> = {};
  for (const [month, raw] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const days = parseMonthStats(raw);
    if (!days || Object.keys(days).some((date) => !date.startsWith(`${month}-`))) return;
    stats[month] = days;
  }
  return stats;
}

/** Reading a page changes state, not every cover in the catalog. */
export function applyPeerUpdate(previous: PeerSnapshot | undefined, value: unknown): PeerSnapshot | undefined {
  if (!previous || typeof value !== "object" || value === null) return;
  const state = "state" in value ? parseDeviceState(value.state) : previous.state;
  const catalog = "catalog" in value ? parseCatalog(value.catalog) : previous.catalog;
  const stats = "stats" in value ? parseStats(value.stats) : previous.stats;
  return state && catalog && stats ? { v: 1, state: portableState(state), catalog, stats } : undefined;
}

export function portableState(state: DeviceState): DeviceState {
  return { ...state, books: Object.fromEntries(Object.entries(state.books).map(([key, regs]) => {
    const { file: _file, ocr: _ocr, ...portable } = regs;
    return [key, portable];
  })) };
}

/** Both transports may have seen the same device. Merge its registers,
    and take each day's latest counters once, rather than summing copies. */
export function pullPeers(
  snapshots: PeerSnapshot[], me: string, hlc: Hlc,
  remotes: Map<string, { state: DeviceState; rev: string }>,
  stats: Awaited<ReturnType<SyncStore["remoteStats"]>>,
  catalogs: Awaited<ReturnType<SyncStore["remoteCatalogs"]>>,
): void {
  for (const snapshot of snapshots) {
    const id = snapshot.state.device.id;
    if (id === me) continue;
    const known = remotes.get(id);
    const merged = mergeStates(emptyShadow(), [...(known ? [known.state] : []), snapshot.state], hlc);
    for (const [key, regs] of Object.entries(merged.books)) {
      const previous = known?.state.books[key]?.own;
      const current = snapshot.state.books[key]?.own;
      const own = !previous || (current && current.t >= previous.t) ? current : previous;
      if (own) regs.own = own;
    }
    remotes.set(id, {
      rev: `peer:${snapshot.state.seq}`,
      state: { ...snapshot.state, seq: Math.max(known?.state.seq ?? 0, snapshot.state.seq), ...merged },
    });
    for (const [month, days] of Object.entries(snapshot.stats)) {
      const slot = `${id}/${month}`;
      const combined = { ...stats.get(slot)?.days };
      for (const [date, counts] of Object.entries(days)) {
        const old = combined[date];
        if (!old || counts.timeMs >= old.timeMs) combined[date] = counts;
      }
      stats.set(slot, { rev: `peer:${snapshot.state.seq}`, days: combined });
    }
    catalogs.set(id, { rev: `peer:${snapshot.state.seq}`, catalog: snapshot.catalog });
  }
}

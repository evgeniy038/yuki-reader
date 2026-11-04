import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { VaultKeys } from "./crypto";
import { parsePackManifest, type PackManifest } from "./book-pack";
import type { JoinMode, Shadow } from "./merge";
import {
  parseDeviceInfo,
  parseDeviceState,
  parseMonthStats,
  type BookKey,
  type DeviceInfo,
  type DeviceState,
  type MonthStats,
} from "./model";
import type { ProviderKind } from "./remote";

// The sync engine's own IndexedDB ("yuki-sync"), apart from the library
// database: its schema never collides with the library's migrations, and
// forgetting sync (disconnect) is dropping this one database — the library
// is untouched. Records written by this code are still read as unknown and
// narrowed: an IndexedDB record is a trust boundary too (AGENTS.md).

export interface ProviderSession {
  kind: ProviderKind;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (0 = unknown). */
  expiresAt: number;
}

export interface PendingAuth {
  kind: ProviderKind;
  state: string;
  verifier: string;
  createdAt: number;
}

export interface VaultBinding {
  id: string;
  keys: VaultKeys;
  /** This device created the vault (its existing library is the shared one)
      or joined it (it adopts the cloud's organization). */
  mode: JoinMode;
}

export interface SyncStatus {
  at: number;
  ok: boolean;
  /** Registers that went out / came in on the last round. */
  sent: number;
  received: number;
  bytes: number;
  error?: "network" | "auth" | "quota" | "vault" | "unknown";
  /** Tombstones held back by the mass-deletion guard (local ids). */
  heldDeletions: string[];
  /** The cloud ran out of space for book files (reading sync still works). */
  full?: boolean;
}

/** Values the first round overwrote, kept for "undo the first sync". */
export interface PreSyncSnapshot {
  at: number;
  books: {
    id: string;
    progress: number;
    lastReadAt?: number;
    favorite: boolean;
    title: string;
    series?: string;
    volumeIndex?: number;
  }[];
  settings: Record<string, string>;
}

interface SyncDB extends DBSchema {
  kv: { key: string; value: unknown };
}

const KV = "kv";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isKey = (v: unknown): v is CryptoKey =>
  typeof CryptoKey !== "undefined" && v instanceof CryptoKey;
const isProvider = (v: unknown): v is ProviderKind => v === "yandex" || v === "dropbox";

/** A sync database by name — one per device; tests open several. */
export function createSyncStore(dbName = "yuki-sync") {
  let dbPromise: Promise<IDBPDatabase<SyncDB>> | null = null;
  const db = (): Promise<IDBPDatabase<SyncDB>> => {
    dbPromise ??= openDB<SyncDB>(dbName, 1, {
      upgrade(database) {
        database.createObjectStore(KV);
      },
    });
    return dbPromise;
  };
  const get = async (key: string): Promise<unknown> => (await db()).get(KV, key);
  const put = async (key: string, value: unknown): Promise<void> => {
    await (await db()).put(KV, value, key);
  };
  return {
    async device(): Promise<DeviceInfo | undefined> {
      return parseDeviceInfo(await get("device"));
    },
    setDevice: (device: DeviceInfo) => put("device", device),

    async hlc(): Promise<number> {
      const value = await get("hlc");
      return isNum(value) ? value : 0;
    },
    setHlc: (value: number) => put("hlc", value),

    async session(): Promise<ProviderSession | undefined> {
      const v = await get("session");
      if (!isObject(v) || !isProvider(v.kind) || !isStr(v.accessToken) || !isNum(v.expiresAt)) {
        return undefined;
      }
      return {
        kind: v.kind,
        accessToken: v.accessToken,
        expiresAt: v.expiresAt,
        ...(isStr(v.refreshToken) ? { refreshToken: v.refreshToken } : {}),
      };
    },
    setSession: (session: ProviderSession) => put("session", session),

    async pendingAuth(): Promise<PendingAuth | undefined> {
      const v = await get("pendingAuth");
      if (!isObject(v) || !isProvider(v.kind) || !isStr(v.state) || !isStr(v.verifier)) {
        return undefined;
      }
      return { kind: v.kind, state: v.state, verifier: v.verifier, createdAt: isNum(v.createdAt) ? v.createdAt : 0 };
    },
    setPendingAuth: (pending: PendingAuth | null) => put("pendingAuth", pending),

    async vault(): Promise<VaultBinding | undefined> {
      const v = await get("vault");
      if (!isObject(v) || !isStr(v.id) || !isObject(v.keys)) return undefined;
      const { enc, name, fingerprint } = v.keys;
      if (!isKey(enc) || !isKey(name) || !isStr(fingerprint)) return undefined;
      const mode = v.mode === "creator" ? "creator" : "joiner";
      return { id: v.id, keys: { enc, name, fingerprint }, mode };
    },
    setVault: (vault: VaultBinding) => put("vault", vault),

    async shadow(): Promise<Shadow | undefined> {
      const v = await get("shadow");
      if (!isObject(v) || !Array.isArray(v.held)) return undefined;
      // Reuse the published-state parser for the register maps.
      const parsed = parseDeviceState({
        v: 1, vault: "", seq: 0, device: { id: "" }, books: v.books, settings: v.settings,
      });
      if (!parsed) return undefined;
      return { books: parsed.books, settings: parsed.settings, held: v.held.filter(isStr) };
    },
    setShadow: (shadow: Shadow) => put("shadow", shadow),

    async published(): Promise<{ seq: number; hash: string }> {
      const v = await get("published");
      return isObject(v) && isNum(v.seq) && isStr(v.hash) ? { seq: v.seq, hash: v.hash } : { seq: 0, hash: "" };
    },
    setPublished: (value: { seq: number; hash: string }) => put("published", value),

    /** Other devices' states, as last downloaded, with their file revisions. */
    async remotes(): Promise<{ state: DeviceState; rev: string }[]> {
      const v = await get("remotes");
      if (!Array.isArray(v)) return [];
      const out: { state: DeviceState; rev: string }[] = [];
      for (const item of v) {
        if (!isObject(item) || !isStr(item.rev)) continue;
        const state = parseDeviceState(item.state);
        if (state) out.push({ state, rev: item.rev });
      }
      return out;
    },
    setRemotes: (remotes: { state: DeviceState; rev: string }[]) => put("remotes", remotes),

    /** Other devices' stats months: "<deviceId>/<YYYY-MM>" → days + rev. */
    async remoteStats(): Promise<Map<string, { days: MonthStats; rev: string }>> {
      const v = await get("remoteStats");
      const out = new Map<string, { days: MonthStats; rev: string }>();
      if (!isObject(v)) return out;
      for (const [path, item] of Object.entries(v)) {
        if (!isObject(item) || !isStr(item.rev)) continue;
        const days = parseMonthStats(item.days);
        if (days) out.set(path, { days, rev: item.rev });
      }
      return out;
    },
    setRemoteStats: (stats: Map<string, { days: MonthStats; rev: string }>) =>
      put("remoteStats", Object.fromEntries(stats)),

    /** This device's published stats months: "YYYY-MM" → content hash. */
    async publishedStats(): Promise<Record<string, string>> {
      const v = await get("publishedStats");
      if (!isObject(v)) return {};
      return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => isStr(e[1])));
    },
    setPublishedStats: (value: Record<string, string>) => put("publishedStats", value),

    /** Local book id → content key (computed once per book). */
    async bookKeys(): Promise<Map<string, BookKey>> {
      const v = await get("bookKeys");
      if (!isObject(v)) return new Map();
      return new Map(Object.entries(v).filter((e): e is [string, string] => isStr(e[1])));
    },
    setBookKeys: (keys: Map<string, BookKey>) => put("bookKeys", Object.fromEntries(keys)),

    async status(): Promise<SyncStatus | undefined> {
      const v = await get("status");
      if (!isObject(v) || !isNum(v.at) || typeof v.ok !== "boolean") return undefined;
      const errors = ["network", "auth", "quota", "vault", "unknown"] as const;
      const error = errors.find((e) => e === v.error);
      return {
        at: v.at,
        ok: v.ok,
        sent: isNum(v.sent) ? v.sent : 0,
        received: isNum(v.received) ? v.received : 0,
        bytes: isNum(v.bytes) ? v.bytes : 0,
        heldDeletions: Array.isArray(v.heldDeletions) ? v.heldDeletions.filter(isStr) : [],
        ...(error ? { error } : {}),
        ...(v.full === true ? { full: true } : {}),
      };
    },
    setStatus: (status: SyncStatus) => put("status", status),

    async snapshot(): Promise<PreSyncSnapshot | undefined> {
      const v = await get("snapshot");
      if (!isObject(v) || !isNum(v.at) || !Array.isArray(v.books) || !isObject(v.settings)) return undefined;
      const books: PreSyncSnapshot["books"] = [];
      for (const b of v.books) {
        if (!isObject(b) || !isStr(b.id) || !isNum(b.progress) || !isStr(b.title)) continue;
        books.push({
          id: b.id,
          progress: b.progress,
          title: b.title,
          favorite: b.favorite === true,
          ...(isNum(b.lastReadAt) ? { lastReadAt: b.lastReadAt } : {}),
          ...(isStr(b.series) ? { series: b.series } : {}),
          ...(isNum(b.volumeIndex) ? { volumeIndex: b.volumeIndex } : {}),
        });
      }
      const settings = Object.fromEntries(
        Object.entries(v.settings).filter((e): e is [string, string] => isStr(e[1])),
      );
      return { at: v.at, books, settings };
    },
    setSnapshot: (snapshot: PreSyncSnapshot | null) => put("snapshot", snapshot),

    /** OCR packs already applied here: content key → the pack's stamp. */
    async ocrApplied(): Promise<Record<string, number>> {
      const v = await get("ocrApplied");
      if (!isObject(v)) return {};
      return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => isNum(e[1])));
    },
    setOcrApplied: (value: Record<string, number>) => put("ocrApplied", value),

    /** When this device first synced — days before it may hold restored
        copies of another device's reading (see sync/stats.ts). */
    async joinedAt(): Promise<number | undefined> {
      const v = await get("joinedAt");
      return isNum(v) ? v : undefined;
    },
    setJoinedAt: (at: number) => put("joinedAt", at),

    /** A just-created vault's recovery key, kept only until the user says
        it is saved — a reload must not lose the one chance to see it. */
    async recoveryToShow(): Promise<string | undefined> {
      const v = await get("recoveryToShow");
      return isStr(v) ? v : undefined;
    },
    setRecoveryToShow: (key: string | null) => put("recoveryToShow", key),

    /** Cloud books' manifests (covers, sizes) by content key, with the
        `file` register stamp they belong to — fetched once per pack. */
    async packManifests(): Promise<Map<BookKey, { t: number; manifest: PackManifest }>> {
      const v = await get("packManifests");
      const out = new Map<BookKey, { t: number; manifest: PackManifest }>();
      if (!isObject(v)) return out;
      for (const [key, entry] of Object.entries(v)) {
        if (!isObject(entry) || !isNum(entry.t)) continue;
        const manifest = parsePackManifest(entry.manifest);
        if (manifest) out.set(key, { t: entry.t, manifest });
      }
      return out;
    },
    setPackManifests: (value: Map<BookKey, { t: number; manifest: PackManifest }>) =>
      put("packManifests", Object.fromEntries(value)),

    /** Drop everything tied to the current vault (keeps the device and the
        provider session) — before starting over with a new vault. */
    async resetVaultData(): Promise<void> {
      const database = await db();
      for (const key of ["vault", "shadow", "published", "remotes", "remoteStats", "publishedStats", "snapshot", "status", "recoveryToShow", "hlc", "ocrApplied", "packManifests"]) {
        await database.delete(KV, key);
      }
    },

    /** Forget everything about sync on this device (the library stays). */
    async clear(): Promise<void> {
      await (await db()).clear(KV);
    },
  };
}

export type SyncStore = ReturnType<typeof createSyncStore>;

export const syncStore: SyncStore = createSyncStore();

import type { BookFormat } from "../library";
import { toBlock, type MokuroBlock } from "../mokuro";

// The sync data model: what one device publishes into the cloud folder, and
// the shape checks that guard the trust boundary. Everything read back from
// the cloud (or from the sync database) is `unknown` until a parser below
// narrows it — a file that fails is "unknown", never "empty".
//
// Cloud layout (all inside the provider's app folder, every file sealed —
// see crypto.ts — except vault.json, which holds no secrets):
//   vault.json                          vault id + format version
//   keys/recovery.json                  the vault key wrapped by the recovery key
//   devices/<deviceId>/state.bin        DeviceState: registers, the device's full merged view
//   devices/<deviceId>/stats/<YYYY-MM>.bin  MonthStats: this device's OWN counters only
//   devices/<deviceId>/books/<folder>/…     book packs this device uploaded (book-pack.ts)
// A device writes ONLY under its own devices/<id>/ — no shared mutable file,
// so neither provider needs conditional writes.

/** Content identity of a book across devices — see book-key.ts. */
export type BookKey = string;

/** A last-writer-wins register: value, hybrid-logical time, author device. */
export interface Reg<T> {
  v: T;
  t: number;
  d: string;
}

export interface BookRegs {
  /** Descriptive copy for humans and future cloud tiles; never merged. */
  title: string;
  format?: BookFormat;
  progress?: Reg<number>;
  /** The publishing device's OWN last dwell on this book (not merged):
      where it was really read — the "continue from 45% · iPhone" offer. */
  own?: { p: number; t: number };
  /** Max-register: the last moment the book was opened or read anywhere. */
  lastReadAt?: number;
  favorite?: Reg<boolean>;
  name?: Reg<string>;
  series?: Reg<string | null>;
  volumeIndex?: Reg<number | null>;
  /** Tombstone: v true = removed from the library. */
  deleted?: Reg<boolean>;
  /** A finished OCR pack of this manga volume: v = OCR engine version, d =
      the device that published it (devices/<d>/ocr/<folder>.bin). */
  ocr?: Reg<number>;
  /** The book's own files in the cloud: v = pack format version (0 = taken
      back), d = the device that uploaded them (books/<d>/<folder>/). */
  file?: Reg<number>;
  /** Manga only: "keep this volume in the cloud" — EPUB and PDF always go,
      manga volumes only on request (they are hundreds of MB each). */
  keep?: Reg<boolean>;
}

export type DevicePlatform = "iphone" | "ipad" | "mac" | "android" | "windows" | "linux" | "other";
export type DeviceApp = "safari" | "chrome" | "firefox" | "edge" | "app" | "other";

export interface DeviceInfo {
  id: string;
  platform: DevicePlatform;
  app: DeviceApp;
}

export interface DeviceState {
  v: 1;
  vault: string;
  /** Grows with every publish — readers ignore a lower seq (rollback guard). */
  seq: number;
  device: DeviceInfo;
  books: Record<BookKey, BookRegs>;
  /** Synced settings: key → JSON text of the value. */
  settings: Record<string, Reg<string>>;
}

export interface BookAmount {
  chars: number;
  pages: number;
  timeMs: number;
}

export interface DayCount extends BookAmount {
  perBook?: Record<BookKey, BookAmount>;
}

/** One month of ONE device's reading: local day key → counts. */
export type MonthStats = Record<string, DayCount>;

// ---------------------------------------------------------------------------
// Shape checks (trust boundary). Small predicates, no casts of unchecked data.

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isStr = (value: unknown): value is string => typeof value === "string";
const isBool = (value: unknown): value is boolean => typeof value === "boolean";

function reg<T>(value: unknown, isT: (v: unknown) => v is T): Reg<T> | undefined {
  if (!isObject(value) || !isNum(value.t) || !isStr(value.d)) return undefined;
  return isT(value.v) ? { v: value.v, t: value.t, d: value.d } : undefined;
}

const isNullableStr = (v: unknown): v is string | null => v === null || isStr(v);
const isNullableNum = (v: unknown): v is number | null => v === null || isNum(v);
const isProgress = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
const FORMATS: readonly BookFormat[] = ["epub", "pdf", "manga"];
const isFormat = (v: unknown): v is BookFormat =>
  isStr(v) && (FORMATS as readonly string[]).includes(v);

function parseBookRegs(value: unknown): BookRegs | undefined {
  if (!isObject(value) || !isStr(value.title)) return undefined;
  const regs: BookRegs = { title: value.title };
  if (isFormat(value.format)) regs.format = value.format;
  const progress = reg(value.progress, isProgress);
  if (progress) regs.progress = progress;
  if (isObject(value.own) && isProgress(value.own.p) && isNum(value.own.t)) {
    regs.own = { p: value.own.p, t: value.own.t };
  }
  if (isNum(value.lastReadAt)) regs.lastReadAt = value.lastReadAt;
  const favorite = reg(value.favorite, isBool);
  if (favorite) regs.favorite = favorite;
  const name = reg(value.name, isStr);
  if (name) regs.name = name;
  const series = reg(value.series, isNullableStr);
  if (series) regs.series = series;
  const volumeIndex = reg(value.volumeIndex, isNullableNum);
  if (volumeIndex) regs.volumeIndex = volumeIndex;
  const deleted = reg(value.deleted, isBool);
  if (deleted) regs.deleted = deleted;
  const ocr = reg(value.ocr, isNum);
  if (ocr) regs.ocr = ocr;
  const file = reg(value.file, isNum);
  if (file) regs.file = file;
  const keep = reg(value.keep, isBool);
  if (keep) regs.keep = keep;
  return regs;
}

const PLATFORMS: readonly DevicePlatform[] = ["iphone", "ipad", "mac", "android", "windows", "linux", "other"];
const APPS: readonly DeviceApp[] = ["safari", "chrome", "firefox", "edge", "app", "other"];

export function parseDeviceInfo(value: unknown): DeviceInfo | undefined {
  if (!isObject(value) || !isStr(value.id)) return undefined;
  const platform = PLATFORMS.find((p) => p === value.platform) ?? "other";
  const app = APPS.find((a) => a === value.app) ?? "other";
  return { id: value.id, platform, app };
}

/** A published device state, or undefined when the shape is wrong. Single
    malformed books/settings are dropped, the rest survives. */
export function parseDeviceState(value: unknown): DeviceState | undefined {
  if (!isObject(value) || value.v !== 1 || !isStr(value.vault) || !isNum(value.seq)) {
    return undefined;
  }
  const device = parseDeviceInfo(value.device);
  if (!device || !isObject(value.books) || !isObject(value.settings)) return undefined;
  const books: Record<BookKey, BookRegs> = {};
  for (const [key, raw] of Object.entries(value.books)) {
    const regs = parseBookRegs(raw);
    if (regs) books[key] = regs;
  }
  const settings: Record<string, Reg<string>> = {};
  for (const [key, raw] of Object.entries(value.settings)) {
    const setting = reg(raw, isStr);
    if (setting) settings[key] = setting;
  }
  return { v: 1, vault: value.vault, seq: value.seq, device, books, settings };
}

function parseAmount(value: unknown): BookAmount | undefined {
  if (!isObject(value) || !isNum(value.chars) || !isNum(value.pages) || !isNum(value.timeMs)) {
    return undefined;
  }
  return { chars: value.chars, pages: value.pages, timeMs: value.timeMs };
}

export function parseMonthStats(value: unknown): MonthStats | undefined {
  if (!isObject(value)) return undefined;
  const month: MonthStats = {};
  for (const [day, raw] of Object.entries(value)) {
    const amount = parseAmount(raw);
    if (!amount || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(raw)) continue;
    const count: DayCount = { ...amount };
    if (isObject(raw.perBook)) {
      const perBook: Record<BookKey, BookAmount> = {};
      for (const [key, slice] of Object.entries(raw.perBook)) {
        const parsed = parseAmount(slice);
        if (parsed) perBook[key] = parsed;
      }
      count.perBook = perBook;
    }
    month[day] = count;
  }
  return month;
}

export interface VaultFile {
  format: "yuki-sync-vault";
  v: 1;
  id: string;
  createdAt: number;
}

export function parseVaultFile(value: unknown): VaultFile | undefined {
  if (!isObject(value) || value.format !== "yuki-sync-vault" || value.v !== 1) return undefined;
  if (!isStr(value.id) || value.id === "" || !isNum(value.createdAt)) return undefined;
  return { format: "yuki-sync-vault", v: 1, id: value.id, createdAt: value.createdAt };
}

export interface KeySlot {
  kind: "recovery";
  v: 1;
  nonce: string;
  wrapped: string;
}

export function parseKeySlot(value: unknown): KeySlot | undefined {
  if (!isObject(value) || value.kind !== "recovery" || value.v !== 1) return undefined;
  if (!isStr(value.nonce) || !isStr(value.wrapped)) return undefined;
  return { kind: "recovery", v: 1, nonce: value.nonce, wrapped: value.wrapped };
}

/** A volume's finished OCR, as one device publishes it: the recognized
    blocks of every page that needed OCR (sidecar pages are not included). */
export interface OcrPack {
  v: 1;
  engine: number;
  pages: Map<number, MokuroBlock[]>;
}

export function parseOcrPack(value: unknown): OcrPack | undefined {
  if (!isObject(value) || value.v !== 1 || !isNum(value.engine) || !isObject(value.pages)) return undefined;
  const pages = new Map<number, MokuroBlock[]>();
  for (const [index, raw] of Object.entries(value.pages)) {
    const page = Number(index);
    if (!Number.isInteger(page) || page < 0 || !Array.isArray(raw)) return undefined;
    pages.set(page, raw.map(toBlock).filter((block): block is MokuroBlock => block !== null));
  }
  return { v: 1, engine: value.engine, pages };
}

import type { BookFormat } from "../library";
import type { Hlc } from "./hlc";
import type { BookKey, BookRegs, DeviceState, Reg } from "./model";

// The merge rules — pure functions, the seam the engine and the node unit
// test (tests/sync-unit.ts) both cross. One round:
//   1. stampLocalEdits: compare what the app has NOW with the shadow (the
//      registers as last merged) — every difference is an edit made on this
//      device and gets a fresh clock stamp;
//   2. mergeStates: fold every other device's published state in, register
//      by register: the later stamp wins, ties go to the higher device id;
//      absent registers never win ("blank records don't win" — the bug that
//      zeroed progress across ttu/mokuro fleets);
//   3. planLocal: what to write into the app so it shows the merged truth,
//      with the deletion guards.

/** One shelf book as the app has it right now (lean fields only). */
export interface LocalBook {
  id: string;
  key: BookKey;
  title: string;
  format?: BookFormat;
  progress: number;
  lastReadAt?: number;
  favorite: boolean;
  series?: string;
  volumeIndex?: number;
  /** Manga: keep this volume's files in the cloud. */
  keep?: boolean;
}

export interface LocalState {
  books: LocalBook[];
  /** Synced settings: key → JSON text of the value. */
  settings: Record<string, string>;
}

/** This device's sync memory between rounds. */
export interface Shadow {
  books: Record<BookKey, BookRegs>;
  settings: Record<string, Reg<string>>;
  /** Keys this device held when the last round completed — only those can
      be removed here by a remote tombstone. */
  held: BookKey[];
}

/** How a round treats values the shadow has never seen. The vault creator's
    existing library claims stamp 1, a joining device's stamp 0: the first
    device's organization (renames, pins, series) becomes the shared one, and
    any real edit (stamped with the clock) beats both. */
export type JoinMode = "creator" | "joiner";

export const emptyShadow = (): Shadow => ({ books: {}, settings: {}, held: [] });

const EPS = 1e-9;

function later<T>(a: Reg<T> | undefined, b: Reg<T> | undefined): Reg<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.t !== b.t) return a.t > b.t ? a : b;
  return a.d >= b.d ? a : b;
}

/** Step 1: the shadow with every local difference stamped as an edit. */
export function stampLocalEdits(
  shadow: Shadow,
  local: LocalState,
  hlc: Hlc,
  me: string,
  mode: JoinMode,
): Pick<Shadow, "books" | "settings"> {
  const claim = mode === "creator" ? 1 : 0;
  const books: Record<BookKey, BookRegs> = {};
  for (const [key, regs] of Object.entries(shadow.books)) books[key] = { ...regs };
  const present = new Set<BookKey>();

  for (const book of local.books) {
    present.add(book.key);
    const base = books[book.key];
    if (!base) {
      // New to sync: nothing here is an edit yet. Positions merge by when
      // the book was last read; everything else is at most a weak claim.
      const regs: BookRegs = { title: book.title, format: book.format };
      if (book.progress > EPS) {
        const t = book.lastReadAt ?? 0;
        regs.progress = { v: book.progress, t, d: me };
        regs.own = { p: book.progress, t };
      }
      if (book.lastReadAt !== undefined) regs.lastReadAt = book.lastReadAt;
      if (book.favorite) regs.favorite = { v: true, t: claim, d: me };
      regs.name = { v: book.title, t: claim, d: me };
      if (book.series !== undefined) regs.series = { v: book.series, t: claim, d: me };
      if (book.volumeIndex !== undefined)
        regs.volumeIndex = { v: book.volumeIndex, t: claim, d: me };
      if (book.keep) regs.keep = { v: true, t: claim, d: me };
      books[book.key] = regs;
      continue;
    }
    const next: BookRegs = { ...base, title: book.title, format: book.format ?? base.format };
    if (Math.abs(book.progress - (base.progress?.v ?? 0)) > EPS) {
      const t = hlc.now();
      next.progress = { v: book.progress, t, d: me };
      next.own = { p: book.progress, t };
    }
    if (book.lastReadAt !== undefined && book.lastReadAt > (base.lastReadAt ?? 0)) {
      next.lastReadAt = book.lastReadAt;
    }
    if (book.favorite !== (base.favorite?.v ?? false)) {
      next.favorite = { v: book.favorite, t: hlc.now(), d: me };
    }
    if (book.title !== (base.name?.v ?? base.title)) {
      next.name = { v: book.title, t: hlc.now(), d: me };
    }
    if ((book.series ?? null) !== (base.series?.v ?? null)) {
      next.series = { v: book.series ?? null, t: hlc.now(), d: me };
    }
    if ((book.volumeIndex ?? null) !== (base.volumeIndex?.v ?? null)) {
      next.volumeIndex = { v: book.volumeIndex ?? null, t: hlc.now(), d: me };
    }
    if ((book.keep ?? false) !== (base.keep?.v ?? false)) {
      next.keep = { v: book.keep ?? false, t: hlc.now(), d: me };
    }
    // Present here although the registers say removed: re-imported.
    if (base.deleted?.v === true) next.deleted = { v: false, t: hlc.now(), d: me };
    books[book.key] = next;
  }

  // Held at the end of the last round, gone now: deleted on this device.
  for (const key of shadow.held) {
    const regs = books[key];
    if (present.has(key) || !regs || regs.deleted?.v === true) continue;
    books[key] = { ...regs, deleted: { v: true, t: hlc.now(), d: me } };
  }

  const settings: Record<string, Reg<string>> = { ...shadow.settings };
  for (const [key, value] of Object.entries(local.settings)) {
    const base = settings[key];
    if (!base) settings[key] = { v: value, t: claim, d: me };
    else if (base.v !== value) settings[key] = { v: value, t: hlc.now(), d: me };
  }
  return { books, settings };
}

/** Step 2: fold remote states into ours. Remote stamps from the future are
    skipped (see hlc.ts); trusted ones advance our clock. Our own `own`
    positions are kept — `own` is per-device, never merged. */
export function mergeStates(
  self: Pick<Shadow, "books" | "settings">,
  remotes: DeviceState[],
  hlc: Hlc,
): Pick<Shadow, "books" | "settings"> {
  const trusted = <T>(r: Reg<T> | undefined): Reg<T> | undefined =>
    r && hlc.observe(r.t) ? r : undefined;
  const books: Record<BookKey, BookRegs> = {};
  for (const [key, regs] of Object.entries(self.books)) books[key] = { ...regs };
  for (const remote of remotes) {
    for (const [key, theirs] of Object.entries(remote.books)) {
      const ours = books[key];
      if (!ours) {
        const copy: BookRegs = { title: theirs.title, format: theirs.format };
        copy.progress = trusted(theirs.progress);
        copy.lastReadAt = theirs.lastReadAt;
        copy.favorite = trusted(theirs.favorite);
        copy.name = trusted(theirs.name);
        copy.series = trusted(theirs.series);
        copy.volumeIndex = trusted(theirs.volumeIndex);
        copy.deleted = trusted(theirs.deleted);
        copy.ocr = trusted(theirs.ocr);
        copy.file = trusted(theirs.file);
        copy.keep = trusted(theirs.keep);
        books[key] = dropUndefined(copy);
        continue;
      }
      books[key] = dropUndefined({
        ...ours,
        progress: later(ours.progress, trusted(theirs.progress)),
        lastReadAt: Math.max(ours.lastReadAt ?? 0, theirs.lastReadAt ?? 0) || undefined,
        favorite: later(ours.favorite, trusted(theirs.favorite)),
        name: later(ours.name, trusted(theirs.name)),
        series: later(ours.series, trusted(theirs.series)),
        volumeIndex: later(ours.volumeIndex, trusted(theirs.volumeIndex)),
        deleted: later(ours.deleted, trusted(theirs.deleted)),
        ocr: newerOcr(ours.ocr, trusted(theirs.ocr)),
        file: later(ours.file, trusted(theirs.file)),
        keep: later(ours.keep, trusted(theirs.keep)),
      });
    }
  }
  const settings: Record<string, Reg<string>> = { ...self.settings };
  for (const remote of remotes) {
    for (const [key, theirs] of Object.entries(remote.settings)) {
      const winner = later(settings[key], trusted(theirs));
      if (winner) settings[key] = winner;
    }
  }
  return { books, settings };
}

/** OCR packs: a newer engine always wins (older results are re-run anyway);
    within one engine, the later pack. */
function newerOcr(a: Reg<number> | undefined, b: Reg<number> | undefined): Reg<number> | undefined {
  if (!a || !b || a.v === b.v) return later(a, b);
  return a.v > b.v ? a : b;
}

function dropUndefined(regs: BookRegs): BookRegs {
  const out: BookRegs = { title: regs.title };
  for (const [field, value] of Object.entries(regs)) {
    if (value !== undefined) Object.assign(out, { [field]: value });
  }
  return out;
}

export interface BookPatch {
  id: string;
  key: BookKey;
  progress?: number;
  lastReadAt?: number;
  favorite?: boolean;
  title?: string;
  /** null clears the field. */
  series?: string | null;
  volumeIndex?: number | null;
  keep?: boolean;
}

export interface LocalPlan {
  patches: BookPatch[];
  /** Local ids to remove: a remote tombstone for a book this device had
      already synced. */
  deletions: { id: string; key: BookKey }[];
  /** Tombstones held back by the mass-deletion guard — the user decides. */
  heldDeletions: { id: string; key: BookKey }[];
  /** Keys that a tombstone could not remove here (never synced on this
      device) — their presence is stamped back, reviving them. */
  revive: BookKey[];
  settings: Record<string, string>;
}

/** More removals than this in one round stop and ask (Remotely Save's
    "abort above n%"; Anx and Joplin wiped libraries without such a fuse). */
export function deletionLimit(bookCount: number): number {
  return Math.max(3, Math.ceil(bookCount * 0.2));
}

/** Step 3: what the app must change to show the merged registers. */
export function planLocal(
  merged: Pick<Shadow, "books" | "settings">,
  local: LocalState,
  held: readonly BookKey[],
): LocalPlan {
  const wasHeld = new Set(held);
  const plan: LocalPlan = { patches: [], deletions: [], heldDeletions: [], revive: [], settings: {} };
  for (const book of local.books) {
    const regs = merged.books[book.key];
    if (!regs) continue;
    if (regs.deleted?.v === true) {
      if (wasHeld.has(book.key)) plan.deletions.push({ id: book.id, key: book.key });
      else plan.revive.push(book.key);
      continue;
    }
    const patch: BookPatch = { id: book.id, key: book.key };
    if (regs.progress && Math.abs(regs.progress.v - book.progress) > EPS) patch.progress = regs.progress.v;
    if ((regs.lastReadAt ?? 0) > (book.lastReadAt ?? 0)) patch.lastReadAt = regs.lastReadAt;
    if (regs.favorite && regs.favorite.v !== book.favorite) patch.favorite = regs.favorite.v;
    if (regs.name && regs.name.v !== book.title) patch.title = regs.name.v;
    if (regs.series && regs.series.v !== (book.series ?? null)) patch.series = regs.series.v;
    if (regs.volumeIndex && regs.volumeIndex.v !== (book.volumeIndex ?? null)) {
      patch.volumeIndex = regs.volumeIndex.v;
    }
    if (regs.keep && regs.keep.v !== (book.keep ?? false)) patch.keep = regs.keep.v;
    if (Object.keys(patch).length > 2) plan.patches.push(patch);
  }
  if (plan.deletions.length > deletionLimit(local.books.length)) {
    plan.heldDeletions = plan.deletions;
    plan.deletions = [];
  }
  for (const [key, reg] of Object.entries(merged.settings)) {
    if (local.settings[key] !== undefined && local.settings[key] !== reg.v) plan.settings[key] = reg.v;
  }
  return plan;
}

/** Stamp presence back for books a tombstone may not remove here. */
export function reviveBooks(
  merged: Pick<Shadow, "books" | "settings">,
  keys: readonly BookKey[],
  hlc: Hlc,
  me: string,
): void {
  for (const key of keys) {
    const regs = merged.books[key];
    if (regs) merged.books[key] = { ...regs, deleted: { v: false, t: hlc.now(), d: me } };
  }
}

/** The furthest position another device really read this book to — offered
    as "continue from 45% · iPhone" when it is ahead of where we open. */
export function furthestElsewhere(
  remotes: readonly DeviceState[],
  key: BookKey,
  current: number,
): { p: number; t: number; device: DeviceState["device"] } | undefined {
  let best: { p: number; t: number; device: DeviceState["device"] } | undefined;
  for (const remote of remotes) {
    const own = remote.books[key]?.own;
    if (!own || own.p <= current + 0.01) continue;
    if (!best || own.p > best.p) best = { p: own.p, t: own.t, device: remote.device };
  }
  return best;
}

/** Canonical JSON (sorted keys) — stable bytes for "did anything change". */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

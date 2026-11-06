import { Hlc } from "@/core/sync/hlc";
import { writeSyncedSettings } from "@/core/sync/local";
import { furthestElsewhere } from "@/core/sync/merge";
import type { DeviceInfo } from "@/core/sync/model";
import { syncStore } from "@/core/sync/store";
import { writePatches } from "./sync-bridge";
import { currentHost, device, getView, patchView, remotes, requestSync } from "./sync-controller";

// The actions that follow a round's results — the first-sync undo, the
// mass-deletion answer and the "continue from 45% · iPhone" offer. They
// only read the controller's state, never drive the round itself.

/** Put back what the first sync overwrote; the values become fresh edits. */
export async function undoFirstSync(): Promise<void> {
  const snapshot = await syncStore.snapshot();
  const host = currentHost();
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
  patchView({ snapshotAt: undefined });
  requestSync(0);
}

/** Answer the mass-deletion guard. */
export async function resolveHeldDeletions(remove: boolean): Promise<void> {
  const view = getView();
  const ids = view.heldDeletions;
  if (ids.length === 0) return;
  if (remove) {
    currentHost()?.remove(ids);
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
  patchView({ heldDeletions: [] });
  requestSync(0);
}

/** "Continue from 45% · iPhone": the furthest place another device read. */
export async function offerFor(bookId: string, progress: number): Promise<{ p: number; device: DeviceInfo } | undefined> {
  const key = (await syncStore.bookKeys()).get(bookId);
  if (!key) return undefined;
  const best = furthestElsewhere(remotes(), key, progress);
  return best ? { p: best.p, device: best.device } : undefined;
}

/** Move a book's stored position (the offer's action). */
export async function jumpTo(bookId: string, progress: number): Promise<void> {
  const host = currentHost();
  if (!host) return;
  const current = new Map(host.books().map((book) => [book.id, book]));
  const patch = { id: bookId, key: "", progress, lastReadAt: Date.now() };
  await writePatches([patch], current);
  host.patch([patch]);
  requestSync();
}

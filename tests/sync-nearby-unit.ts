import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { syncRound, type LocalBridge } from "../src/core/sync/engine.ts";
import { createSyncStore } from "../src/core/sync/store.ts";
import type { LocalBook, LocalState } from "../src/core/sync/merge.ts";
import { applyPeerUpdate, parsePeerSnapshot, type PeerSnapshot } from "../src/core/sync/peer-snapshot.ts";
import { mergeStatsDays } from "../src/core/sync/stats.ts";
import type { DailyStats } from "../src/core/stats.ts";

function device(id: string, books: LocalBook[], days: DailyStats[]) {
  const store = createSyncStore(`nearby-test-${id}`);
  const local: LocalState = { books, settings: { lang: '"en"' } };
  let sent: PeerSnapshot | undefined;
  let received: PeerSnapshot[] = [];
  const bridge: LocalBridge = {
    snapshot: async () => structuredClone(local),
    apply: async (plan) => {
      for (const patch of plan.patches) {
        const book = local.books.find((book) => book.id === patch.id);
        if (book && patch.progress !== undefined) book.progress = patch.progress;
        if (book && patch.favorite !== undefined) book.favorite = patch.favorite;
      }
      local.books = local.books.filter((book) => !plan.deletions.some((deletion) => deletion.id === book.id));
      Object.assign(local.settings, plan.settings);
    },
    localStats: async () => days,
    keyOf: (id) => local.books.find((book) => book.id === id)?.key,
    catalog: async () => Object.fromEntries(local.books.map((book) => [book.key, { title: book.title, format: "epub", size: 10 }])),
    ocrEngine: 1, finishedOcr: async () => null, applyOcr: async () => {},
    packSource: async () => { throw new Error("Account-free sync must not upload cloud packs"); },
  };
  return {
    store, local,
    receive(snapshot: PeerSnapshot) { received = [snapshot]; },
    snapshot() { assert.ok(sent); return structuredClone(sent); },
    round: () => syncRound({
      remote: null, vault: null, store, bridge, device: { id, platform: "mac", app: "chrome" },
      peer: { snapshots: () => received, publish: async (snapshot) => { sent = structuredClone(snapshot); } },
    }),
  };
}

const date = "2026-11-05";
const mac = device("mac", [{ id: "a", key: "shared", title: "Book", progress: 0.42, lastReadAt: 100, favorite: true }], [{ date, chars: 100, pages: 0, timeMs: 1000 }]);
const phone = device("phone", [{ id: "b", key: "shared", title: "Book", progress: 0, favorite: false }], [{ date, chars: 50, pages: 0, timeMs: 500 }]);
await mac.round();
const incoming = mac.snapshot();
incoming.state.books.shared!.file = { v: 2, t: 5, d: "mac" };
incoming.state.books.shared!.ocr = { v: 2, t: 5, d: "mac" };
const validated = parsePeerSnapshot(incoming);
assert.ok(validated);
assert.equal(applyPeerUpdate(validated, { state: validated.state })?.catalog, validated.catalog, "a reading update reuses the unchanged catalog");
assert.equal(applyPeerUpdate(undefined, { state: validated.state }), undefined);
assert.equal(validated.state.books.shared!.file, undefined);
assert.equal(validated.state.books.shared!.ocr, undefined);
phone.receive(validated);
await phone.round();
assert.equal(phone.local.books[0]!.progress, 0.42);
assert.equal(phone.local.books[0]!.favorite, true);
phone.local.books[0]!.progress = 0.77;
await phone.round();
mac.receive(phone.snapshot());
await mac.round();
assert.equal(mac.local.books[0]!.progress, 0.77);
for (let round = 0; round < 3; round++) {
  phone.receive(mac.snapshot()); await phone.round();
  mac.receive(phone.snapshot()); await mac.round();
}
const remote = [...(await mac.store.remoteStats()).values()].map(({ days }) => ({ device: "phone", days }));
assert.equal(remote.length, 1);
assert.equal(mergeStatsDays([{ date, chars: 100, pages: 0, timeMs: 1000 }], remote, () => undefined)[0]!.timeMs, 1500);
assert.equal((await mac.store.remotes())[0]!.state.books.shared!.own?.p, 0.77);
assert.equal(await mac.store.session(), undefined);
assert.equal(await phone.store.vault(), undefined);
assert.equal(parsePeerSnapshot({ ...incoming, stats: { "2026-11": { "2025-01-01": { chars: 1, pages: 0, timeMs: 1 } } } }), undefined);
console.log("✓ account-free rounds converge, preserve personal reading and count each device once");
console.log("✓ cloud-specific references stay out of direct metadata; invalid stats are rejected");

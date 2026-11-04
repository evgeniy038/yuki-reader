import { strict as assert } from "node:assert";
import { epubKey, mangaKey, pdfKey } from "../src/core/sync/book-key.ts";
import {
  deriveVaultKeys,
  formatRecoveryKey,
  parseRecoveryKey,
  randomBytes,
  seal,
  SealError,
  unseal,
  unwrapWithRecovery,
  wrapWithRecovery,
} from "../src/core/sync/crypto.ts";
import { Hlc, MAX_DRIFT_MS } from "../src/core/sync/hlc.ts";
import {
  emptyShadow,
  furthestElsewhere,
  mergeStates,
  planLocal,
  stampLocalEdits,
  type LocalBook,
  type LocalState,
  type Shadow,
} from "../src/core/sync/merge.ts";
import type { DeviceState } from "../src/core/sync/model.ts";
import { mergeStatsDays } from "../src/core/sync/stats.ts";

// Sync rules, pure: clock, merge, content keys, sealing, recovery keys and
// the cross-device stats sum. The engine over a real (fake) IndexedDB and an
// in-memory cloud is in sync-engine-unit.ts.

const NOW = 1_800_000_000_000;
const clock = () => NOW;
const hlc = (last = 0) => new Hlc(last, clock);

function book(over: Partial<LocalBook> & Pick<LocalBook, "id" | "key">): LocalBook {
  return { title: `Book ${over.id}`, progress: 0, favorite: false, format: "epub", ...over };
}

function published(id: string, self: Pick<Shadow, "books" | "settings">, seq = 1): DeviceState {
  return { v: 1, vault: "v", seq, device: { id, platform: "mac", app: "chrome" }, ...self };
}

// --- Clock -----------------------------------------------------------------
{
  const c = hlc(NOW + 10);
  assert.ok(c.now() > NOW + 10, "never runs backwards");
  assert.equal(c.observe(NOW + MAX_DRIFT_MS - 1), true, "stamps within the drift are trusted");
  assert.equal(c.observe(NOW + MAX_DRIFT_MS + 1), false, "a stamp from the far future is refused");
  assert.ok(c.now() > NOW + MAX_DRIFT_MS - 1, "after observing, local stamps land later");
}

// --- A blank record never wins (ttu/mokuro zeroed progress this way) --------
{
  const a: LocalState = { books: [book({ id: "a1", key: "e1:x", progress: 0.4, lastReadAt: NOW - 1000 })], settings: {} };
  const aState = stampLocalEdits(emptyShadow(), a, hlc(), "devA", "creator");
  // B just imported the same book: progress 0, freshly "read" (import time).
  const b: LocalState = { books: [book({ id: "b1", key: "e1:x", progress: 0, lastReadAt: NOW })], settings: {} };
  const bSelf = stampLocalEdits(emptyShadow(), b, hlc(), "devB", "joiner");
  assert.equal(bSelf.books["e1:x"]!.progress, undefined, "progress 0 creates no register");
  const merged = mergeStates(bSelf, [published("devA", aState)], hlc());
  assert.equal(merged.books["e1:x"]!.progress?.v, 0.4, "the real position wins over the blank one");
  const plan = planLocal(merged, b, []);
  assert.deepEqual(plan.patches.map((p) => [p.id, p.progress]), [["b1", 0.4]], "B is told to jump to 0.4");
}

// --- Latest dwell wins; the further position elsewhere is offered -----------
{
  const shadowA: Shadow = { ...emptyShadow(), held: ["e1:x"] };
  shadowA.books["e1:x"] = { title: "X", progress: { v: 0.6, t: NOW - 50_000, d: "devA" }, own: { p: 0.6, t: NOW - 50_000 } };
  // A stale device that turned one page after missing the sync.
  const shadowB: Shadow = { ...emptyShadow(), held: ["e1:x"] };
  shadowB.books["e1:x"] = { title: "X", progress: { v: 0.3, t: NOW - 90_000, d: "devB" } };
  const bLocal: LocalState = { books: [book({ id: "b1", key: "e1:x", progress: 0.31 })], settings: {} };
  const bSelf = stampLocalEdits(shadowB, bLocal, hlc(NOW), "devB", "joiner");
  assert.equal(bSelf.books["e1:x"]!.own?.p, 0.31, "a local dwell records this device's own position");
  const aState = published("devA", { books: shadowA.books, settings: {} });
  const merged = mergeStates(bSelf, [aState], hlc(NOW));
  assert.equal(merged.books["e1:x"]!.progress?.v, 0.31, "the newest dwell is the shared position");
  const offer = furthestElsewhere([aState], "e1:x", 0.31);
  assert.equal(offer?.p, 0.6, "…but the further place read on the Mac is offered");
  assert.equal(offer?.device.id, "devA");
  assert.equal(furthestElsewhere([aState], "e1:x", 0.6), undefined, "no offer once we are there");
}

// --- First join: the creator's organization wins, pins unite ----------------
{
  const creator: LocalState = {
    books: [
      book({ id: "a1", key: "e1:x", title: "Renamed on Mac", favorite: true }),
      book({ id: "a2", key: "e1:y" }),
    ],
    settings: { "reading.theme": '"sepia"' },
  };
  const joiner: LocalState = {
    books: [
      book({ id: "b1", key: "e1:x", title: "Default title" }),
      book({ id: "b2", key: "e1:y", favorite: true }),
    ],
    settings: { "reading.theme": '"dark"' },
  };
  const aState = published("devA", stampLocalEdits(emptyShadow(), creator, hlc(), "devA", "creator"));
  const bSelf = stampLocalEdits(emptyShadow(), joiner, hlc(), "devB", "joiner");
  const merged = mergeStates(bSelf, [aState], hlc());
  const plan = planLocal(merged, joiner, []);
  const patch = (id: string) => plan.patches.find((p) => p.id === id);
  assert.equal(patch("b1")?.title, "Renamed on Mac", "the creator's rename is adopted");
  assert.equal(patch("b1")?.favorite, true, "the creator's pin is adopted");
  assert.equal(patch("b2")?.favorite, undefined, "the joiner's own pin survives (union)");
  assert.equal(plan.settings["reading.theme"], '"sepia"', "the creator's settings are adopted");
  // A real edit after joining beats the creator's initial claim.
  const shadowB: Shadow = { ...merged, held: ["e1:x", "e1:y"] };
  const edited = stampLocalEdits(shadowB, { ...joiner, settings: { "reading.theme": '"dark"' } }, hlc(NOW), "devB", "joiner");
  assert.equal(mergeStates(edited, [aState], hlc(NOW)).settings["reading.theme"]?.v, '"dark"', "a later edit wins");
}

// --- Deletion: three guards -------------------------------------------------
{
  const keys = ["e1:1", "e1:2", "e1:3", "e1:4", "e1:5", "e1:6", "e1:7", "e1:8", "e1:9", "e1:10"];
  const library: LocalState = { books: keys.map((key, i) => book({ id: `l${i}`, key })), settings: {} };
  const synced: Shadow = {
    books: Object.fromEntries(keys.map((key) => [key, { title: key }])),
    settings: {},
    held: keys,
  };
  // The other device deleted one book: it goes here too.
  const one = published("devA", {
    books: { "e1:1": { title: "e1:1", deleted: { v: true, t: NOW - 10, d: "devA" } } },
    settings: {},
  });
  const plan = planLocal(mergeStates(stampLocalEdits(synced, library, hlc(), "devB", "joiner"), [one], hlc()), library, synced.held);
  assert.deepEqual(plan.deletions.map((d) => d.id), ["l0"], "a synced book follows a remote delete");
  // Five at once is more than max(3, 20%) of ten: held back, the user decides.
  const five = published("devA", {
    books: Object.fromEntries(keys.slice(0, 5).map((key) => [key, { title: key, deleted: { v: true, t: NOW - 10, d: "devA" } }])),
    settings: {},
  });
  const guarded = planLocal(mergeStates(stampLocalEdits(synced, library, hlc(), "devB", "joiner"), [five], hlc()), library, synced.held);
  assert.equal(guarded.deletions.length, 0, "a mass delete is not applied silently");
  assert.equal(guarded.heldDeletions.length, 5, "…it waits for the user");
  // A device joining with a book deleted long ago elsewhere: never removed.
  const fresh = planLocal(mergeStates(stampLocalEdits(emptyShadow(), library, hlc(), "devC", "joiner"), [one], hlc()), library, []);
  assert.equal(fresh.deletions.length, 0, "no deletion on a device that never synced the book");
  assert.deepEqual(fresh.revive, ["e1:1"], "…its presence revives the book instead");
  // Deleted here: the tombstone is stamped; re-imported: presence wins.
  const gone = stampLocalEdits(synced, { books: library.books.slice(1), settings: {} }, hlc(NOW), "devB", "joiner");
  assert.equal(gone.books["e1:1"]!.deleted?.v, true, "a local delete becomes a tombstone");
  const back = stampLocalEdits({ ...synced, books: gone.books, held: keys.slice(1) }, library, hlc(NOW + 5), "devB", "joiner");
  assert.equal(back.books["e1:1"]!.deleted?.v, false, "re-importing stamps the book back");
}

// --- A skewed clock can't win for hours (Readest's bug) ---------------------
{
  const local: LocalState = { books: [book({ id: "b1", key: "e1:x", favorite: true })], settings: {} };
  const shadow: Shadow = { books: { "e1:x": { title: "X", favorite: { v: true, t: NOW - 1, d: "devB" } } }, settings: {}, held: ["e1:x"] };
  const future = published("devA", {
    books: { "e1:x": { title: "X", favorite: { v: false, t: NOW + 3_600_000, d: "devA" } } },
    settings: {},
  });
  const merged = mergeStates(stampLocalEdits(shadow, local, hlc(NOW), "devB", "joiner"), [future], hlc(NOW));
  assert.equal(merged.books["e1:x"]!.favorite?.v, true, "an hour-ahead stamp is not trusted");
}

// --- OCR packs: a newer engine wins, then the later pack ---------------------
{
  const shadow: Shadow = { books: { "m1:v": { title: "V", format: "manga", ocr: { v: 4, t: NOW - 100, d: "devB" } } }, settings: {}, held: ["m1:v"] };
  const local: LocalState = { books: [book({ id: "b1", key: "m1:v", format: "manga" })], settings: {} };
  const olderEngineLater = published("devA", { books: { "m1:v": { title: "V", ocr: { v: 3, t: NOW - 10, d: "devA" } } }, settings: {} });
  const merged = mergeStates(stampLocalEdits(shadow, local, hlc(NOW), "devB", "joiner"), [olderEngineLater], hlc(NOW));
  assert.deepEqual(merged.books["m1:v"]!.ocr, { v: 4, t: NOW - 100, d: "devB" }, "an older engine's pack never replaces a newer one");
  const sameEngineLater = published("devA", { books: { "m1:v": { title: "V", ocr: { v: 4, t: NOW - 10, d: "devA" } } }, settings: {} });
  const again = mergeStates(stampLocalEdits(shadow, local, hlc(NOW), "devB", "joiner"), [sameEngineLater], hlc(NOW));
  assert.equal(again.books["m1:v"]!.ocr?.d, "devA", "within one engine the later pack is current");
}

// --- Content keys: by content, not by name or markup -------------------------
{
  const a = await epubKey([{ html: "<p>国境の<ruby>長<rt>なが</rt></ruby>いトンネル</p>" }]);
  const b = await epubKey([{ html: '<div class="x">\n国境の長い<span>トンネル</span></div>' }]);
  const c = await epubKey([{ html: "<p>雪国であった</p>" }]);
  assert.equal(a, b, "ruby readings, tags and whitespace don't change the key");
  assert.notEqual(a, c, "different text, different key");
  assert.ok(a.startsWith("e1:"));
  const imageOnly1 = await epubKey([{ html: "<img/>" }], [{ bytes: new Uint8Array([1, 2]) }]);
  const imageOnly2 = await epubKey([{ html: "<img/>" }], [{ bytes: new Uint8Array([3, 4]) }]);
  assert.notEqual(imageOnly1, imageOnly2, "image-only books fall back to their resources");
  assert.equal(await pdfKey(new Uint8Array([1, 2, 3])), await pdfKey(new Uint8Array([1, 2, 3])));
  const page = (n: number) => ({ size: 1000 + n, head: new Uint8Array([n, n + 1, n + 2]) });
  const vol = await mangaKey([page(1), page(2), page(3)]);
  assert.equal(vol, await mangaKey([page(1), page(2), page(3)]), "same scans, same key — whatever the file name");
  assert.notEqual(vol, await mangaKey([page(1), page(3), page(2)]), "page order matters");
}

// --- Sealing: bound to vault and path, tamper-evident ------------------------
{
  const keys = await deriveVaultKeys(randomBytes(32));
  const data = new TextEncoder().encode(JSON.stringify({ hello: "世界" }));
  const sealed = await seal(keys, "vault1", "devices/a/state.bin", data);
  const opened = await unseal(keys, "vault1", "devices/a/state.bin", sealed);
  assert.equal(new TextDecoder().decode(opened), JSON.stringify({ hello: "世界" }));
  await assert.rejects(unseal(keys, "vault1", "devices/b/state.bin", sealed), SealError, "moved to another path");
  await assert.rejects(unseal(keys, "vault2", "devices/a/state.bin", sealed), SealError, "replayed into another vault");
  const flipped = sealed.slice();
  flipped[flipped.length - 1] ^= 1;
  await assert.rejects(unseal(keys, "vault1", "devices/a/state.bin", flipped), SealError, "one flipped bit");
  const other = await deriveVaultKeys(randomBytes(32));
  await assert.rejects(unseal(other, "vault1", "devices/a/state.bin", sealed), SealError, "another key");
  assert.notEqual(keys.fingerprint, other.fingerprint);
}

// --- Recovery key: format, typo check, wrapping ------------------------------
{
  const bytes = randomBytes(16);
  const text = formatRecoveryKey(bytes);
  assert.match(text, /^([0-9A-HJKMNP-TV-Z*~$=U]{4}-){6}[0-9A-HJKMNP-TV-Z*~$=U]{3}$/);
  assert.deepEqual(parseRecoveryKey(text), bytes, "round trip");
  assert.deepEqual(parseRecoveryKey(text.toLowerCase().replace(/-/g, " ")), bytes, "case and separators don't matter");
  const typo = text.slice(0, 5) + (text[5] === "A" ? "B" : "A") + text.slice(6);
  assert.equal(parseRecoveryKey(typo), null, "a typo is caught by the check symbol");
  assert.equal(parseRecoveryKey("YUKI"), null);
  const dk = randomBytes(32);
  const slot = await wrapWithRecovery(dk, bytes, "vault1");
  assert.deepEqual(await unwrapWithRecovery(slot, bytes, "vault1"), dk, "the right key opens the slot");
  assert.equal(await unwrapWithRecovery(slot, randomBytes(16), "vault1"), null, "a wrong key doesn't");
  assert.equal(await unwrapWithRecovery(slot, bytes, "vault2"), null, "the slot is bound to its vault");
}

// --- Stats add up across devices, never twice --------------------------------
{
  const local = [{ date: "2026-11-01", chars: 1000, pages: 0, timeMs: 600_000, perBook: { b1: { chars: 1000, pages: 0, timeMs: 600_000 } } }];
  const remote = [
    { device: "devA", days: { "2026-11-01": { chars: 500, pages: 2, timeMs: 300_000, perBook: { "e1:x": { chars: 500, pages: 0, timeMs: 200_000 } } } } },
  ];
  const merged = mergeStatsDays(local, remote, (key) => (key === "e1:x" ? "b1" : undefined));
  assert.equal(merged[0]!.chars, 1500, "two devices' reading adds up");
  assert.equal(merged[0]!.pages, 2);
  assert.equal(merged[0]!.perBook?.b1?.chars, 1500, "per-book slices meet under the local id");
  const again = mergeStatsDays(local, [...remote, ...[]], (key) => (key === "e1:x" ? "b1" : undefined));
  assert.deepEqual(again, merged, "merging again changes nothing (no recount)");
  assert.equal(local[0]!.chars, 1000, "the local record is not mutated");
  const sameDay = [{ device: "devA", days: { "2026-11-01": { chars: 1000, pages: 0, timeMs: 600_000 } } }];
  assert.equal(
    mergeStatsDays(local, sameDay, () => undefined, "2026-11-02")[0]!.chars,
    1000,
    "an identical day from before joining (a restored backup) counts once",
  );
  assert.equal(
    mergeStatsDays(local, sameDay, () => undefined, "2026-11-01")[0]!.chars,
    2000,
    "the same amount read on both devices after joining adds up",
  );
}

console.log("sync unit: all good");

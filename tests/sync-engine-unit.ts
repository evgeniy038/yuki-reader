import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { formatRecoveryKey, randomBytes } from "../src/core/sync/crypto.ts";
import { statePath, syncRound, type LocalBridge } from "../src/core/sync/engine.ts";
import type { LocalBook, LocalState } from "../src/core/sync/merge.ts";
import type { DeviceInfo } from "../src/core/sync/model.ts";
import type { RemoteEntry, RemoteFolder } from "../src/core/sync/remote.ts";
import { mergeStatsDays } from "../src/core/sync/stats.ts";
import { createSyncStore, type VaultBinding } from "../src/core/sync/store.ts";
import { createVault, unlockVault, VaultError } from "../src/core/sync/vault.ts";
import type { DailyStats } from "../src/core/stats.ts";

// Two devices, one in-memory cloud folder, the real engine and the real
// sync database (fake-indexeddb): the whole protocol end to end, minus the
// provider's HTTP (sync-providers-unit.ts) and the UI (sync-smoke.ts).

class MemoryFolder implements RemoteFolder {
  readonly kind = "memory";
  readonly files = new Map<string, { bytes: Uint8Array; rev: string }>();
  private revs = 0;
  async list(dir: string): Promise<RemoteEntry[]> {
    return [...this.files]
      .filter(([path]) => path.startsWith(`${dir}/`))
      .map(([path, file]) => ({ path, rev: file.rev, size: file.bytes.length }));
  }
  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.bytes.slice() ?? null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.revs += 1;
    this.files.set(path, { bytes: bytes.slice(), rev: `r${this.revs}` });
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  /** What a hostile or buggy provider could do: serve old bytes as new. */
  replace(path: string, bytes: Uint8Array): void {
    this.revs += 1;
    this.files.set(path, { bytes, rev: `r${this.revs}` });
  }
}

type Blocks = { box: [number, number, number, number]; vertical: boolean; font_size: number; lines: string[] }[];

interface Device {
  info: DeviceInfo;
  /** Finished OCR per local id (absent = not finished on this device). */
  ocr: Map<string, Map<number, Blocks>>;
  ocrApplied: string[];
  store: ReturnType<typeof createSyncStore>;
  library: LocalState;
  days: DailyStats[];
  keys: Map<string, string>;
  vault?: VaultBinding;
  bridge: LocalBridge;
}

function device(id: string, books: LocalBook[], days: DailyStats[], settings: Record<string, string>): Device {
  const library: LocalState = { books, settings };
  const keys = new Map(books.map((b) => [b.id, b.key]));
  const ocr = new Map<string, Map<number, Blocks>>();
  const ocrApplied: string[] = [];
  const dev: Device = {
    info: { id, platform: "mac", app: "chrome" },
    ocr,
    ocrApplied,
    store: createSyncStore(`yuki-sync-test-${id}`),
    library,
    days,
    keys,
    bridge: {
      snapshot: async () => ({
        books: library.books.map((b) => ({ ...b })),
        settings: { ...library.settings },
      }),
      apply: async (plan) => {
        for (const patch of plan.patches) {
          const target = library.books.find((b) => b.id === patch.id);
          if (!target) continue;
          if (patch.progress !== undefined) target.progress = patch.progress;
          if (patch.lastReadAt !== undefined) target.lastReadAt = patch.lastReadAt;
          if (patch.favorite !== undefined) target.favorite = patch.favorite;
          if (patch.title !== undefined) target.title = patch.title;
        }
        const removed = new Set(plan.deletions.map((d) => d.id));
        library.books = library.books.filter((b) => !removed.has(b.id));
        Object.assign(library.settings, plan.settings);
      },
      localStats: async () => days,
      keyOf: (localId) => keys.get(localId),
      ocrEngine: 4,
      finishedOcr: async (localId) => ocr.get(localId) ?? null,
      applyOcr: async (localId, pages) => {
        ocr.set(localId, pages);
        ocrApplied.push(localId);
      },
    },
  };
  return dev;
}

const round = (dev: Device, cloud: RemoteFolder) =>
  syncRound({ remote: cloud, store: dev.store, vault: dev.vault!, device: dev.info, bridge: dev.bridge });

const find = (dev: Device, key: string) => dev.library.books.find((b) => b.key === key);

const T0 = Date.now() - 86_400_000;
const cloud = new MemoryFolder();

const mac = device(
  "devA",
  [
    { id: "a-x", key: "e1:x", title: "キッチン", progress: 0.4, lastReadAt: T0 + 5000, favorite: true },
    { id: "a-y", key: "m1:y", title: "推しの子 第01巻", progress: 0.2, lastReadAt: T0, favorite: false, format: "manga" },
  ],
  [{ date: "2026-11-01", chars: 3000, pages: 0, timeMs: 1_200_000, perBook: { "a-x": { chars: 3000, pages: 0, timeMs: 1_200_000 } } }],
  { "reading.theme": '"sepia"' },
);
const phone = device(
  "devB",
  [
    // Same novel, imported independently: other local id, older position.
    { id: "b-x", key: "e1:x", title: "キッチン", progress: 0.1, lastReadAt: T0, favorite: false },
    { id: "b-z", key: "e1:z", title: "変な家", progress: 0, lastReadAt: T0, favorite: false },
    { id: "b-y", key: "m1:y", title: "Oshinoko_1", progress: 0, lastReadAt: T0, favorite: false, format: "manga" },
  ],
  [{ date: "2026-11-01", chars: 500, pages: 0, timeMs: 300_000, perBook: { "b-x": { chars: 500, pages: 0, timeMs: 300_000 } } }],
  { "reading.theme": '"dark"' },
);

mac.ocr.set("a-y", new Map([[3, [{ box: [10, 20, 110, 220], vertical: true, font_size: 28, lines: ["かぐや様は告らせたい"] }]]]));

// --- The first device creates the vault and publishes --------------------
const created = await createVault(cloud);
mac.vault = created.binding;
await mac.store.setVault(created.binding);
const reloaded = await mac.store.vault();
assert.equal(reloaded?.keys.fingerprint, created.binding.keys.fingerprint, "the key survives the sync database");
const first = await round(mac, cloud);
assert.ok(first.bytes > 0, "the first round uploads");
assert.ok(cloud.files.has(statePath("devA")), "the device state is in the cloud");
assert.ok(cloud.files.has("devices/devA/stats/2026-11.bin"), "…and its own stats month");
const raw = new TextDecoder().decode(cloud.files.get(statePath("devA"))!.bytes);
assert.ok(!raw.includes("キッチン") && !raw.includes("e1:x"), "titles and keys never leave unencrypted");
assert.ok(await mac.store.snapshot(), "the pre-sync snapshot is kept for undo");
const packs = [...cloud.files.keys()].filter((path) => /^devices\/devA\/ocr\/[0-9a-f]{32}\.bin$/.test(path));
assert.equal(packs.length, 1, "the Mac publishes its finished OCR under its own folder, by an opaque name");
assert.ok(
  !new TextDecoder().decode(cloud.files.get(packs[0]!)!.bytes).includes("かぐや"),
  "OCR text never leaves unencrypted",
);
await assert.rejects(createVault(cloud), (e: unknown) => e instanceof VaultError && e.code === "exists");

// --- The phone joins with the recovery key ---------------------------------
await assert.rejects(unlockVault(cloud, "0000-0000"), (e: unknown) => e instanceof VaultError && e.code === "typo");
const wrongKey = formatRecoveryKey(randomBytes(16)); // well-formed, just not ours
await assert.rejects(unlockVault(cloud, wrongKey), (e: unknown) => e instanceof VaultError && e.code === "wrong");
phone.vault = await unlockVault(cloud, created.recoveryKey);
assert.equal(phone.vault.mode, "joiner");
assert.equal(phone.vault.keys.fingerprint, created.binding.keys.fingerprint, "both devices hold the same key");
const join = await round(phone, cloud);
assert.equal(find(phone, "e1:x")?.progress, 0.4, "the Mac's newer position reaches the phone");
assert.equal(find(phone, "e1:x")?.favorite, true, "the Mac's pin is adopted");
assert.equal(phone.library.settings["reading.theme"], '"sepia"', "the Mac's settings are adopted");
assert.ok(join.received >= 2);
assert.deepEqual(phone.ocrApplied, ["b-y"], "the Mac's OCR reached the phone's copy of the volume");
assert.equal(phone.ocr.get("b-y")?.get(3)?.[0]?.lines[0], "かぐや様は告らせたい", "…with the recognized text");
await round(phone, cloud);
assert.equal(phone.ocrApplied.length, 1, "a pack is downloaded once, not every round");

// --- Back on the Mac: the phone's book and reading arrive ------------------
await round(mac, cloud);
assert.equal(find(mac, "e1:x")?.progress, 0.4, "nothing bounced back");
const macRemote = await mac.store.remoteStats();
const totals = mergeStatsDays(mac.days, [...macRemote.values()].map((m) => ({ device: "devB", days: m.days })), (key) =>
  key === "e1:x" ? "a-x" : undefined,
);
assert.equal(totals[0]?.chars, 3500, "a day read on both devices adds up");
assert.equal(totals[0]?.perBook?.["a-x"]?.chars, 3500, "…per book too, under the Mac's own id");

// --- Reading on the phone moves the Mac ------------------------------------
find(phone, "e1:x")!.progress = 0.5;
await round(phone, cloud);
await round(mac, cloud);
assert.equal(find(mac, "e1:x")?.progress, 0.5);
const rolledBack = cloud.files.get(statePath("devB"))!.bytes.slice();
find(phone, "e1:x")!.progress = 0.6;
await round(phone, cloud);
await round(mac, cloud);
assert.equal(find(mac, "e1:x")?.progress, 0.6);

// --- A rollback or a damaged file is ignored, never applied -----------------
cloud.replace(statePath("devB"), rolledBack);
await round(mac, cloud);
assert.equal(find(mac, "e1:x")?.progress, 0.6, "an older state served as new is ignored (seq)");
const damaged = cloud.files.get(statePath("devB"))!.bytes.slice();
damaged[damaged.length - 3] ^= 0xff;
cloud.replace(statePath("devB"), damaged);
const tampered = await round(mac, cloud);
assert.equal(find(mac, "e1:x")?.progress, 0.6, "a tampered file changes nothing");
assert.equal(tampered.received, 0);

// --- Deleting on one device removes it on the other ------------------------
mac.library.books = mac.library.books.filter((b) => b.key !== "e1:x");
await round(mac, cloud);
await round(phone, cloud);
assert.equal(find(phone, "e1:x"), undefined, "a synced book follows the delete");
assert.ok(find(phone, "e1:z"), "the rest of the library stays");

// --- A folder with devices but no vault is never silently replaced ---------
const broken = new MemoryFolder();
await broken.write("devices/devX/state.bin", new Uint8Array([1, 2, 3]));
await assert.rejects(createVault(broken), (e: unknown) => e instanceof VaultError && e.code === "damaged");
const otherCloud = new MemoryFolder();
const other = await createVault(otherCloud);
await assert.rejects(
  unlockVault(otherCloud, other.recoveryKey, created.binding.keys.fingerprint),
  (e: unknown) => e instanceof VaultError && e.code === "changed",
  "a device that knew another key refuses a swapped vault",
);

console.log("sync engine unit: all good");

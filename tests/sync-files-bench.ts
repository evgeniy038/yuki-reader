import "fake-indexeddb/auto";
import { installPack, packDir, planPack, readManifest, uploadPack, type PackSource } from "../src/core/sync/book-pack.ts";
import { folderName } from "../src/core/sync/crypto.ts";
import type { RemoteEntry, RemoteFolder } from "../src/core/sync/remote.ts";
import { createVault } from "../src/core/sync/vault.ts";

// Book-file transfer on a slow cloud: every request pays a fixed latency
// (measured ~0.5–0.9 s to Dropbox through a VPN) and every byte shares one
// link of LINK_MBIT. Prints upload and download time of a manga volume of
// PAGES pages × PAGE_KB. Not part of `pnpm test` — a measuring stick.
// Run: pnpm tsx tests/sync-files-bench.ts

const LATENCY_MS = Number(process.env.LATENCY_MS ?? 600);
const LINK_MBIT = Number(process.env.LINK_MBIT ?? 50);
const PAGES = Number(process.env.PAGES ?? 200);
const PAGE_KB = Number(process.env.PAGE_KB ?? 1200);

class SlowFolder implements RemoteFolder {
  readonly kind = "memory";
  readonly files = new Map<string, Uint8Array>();
  requests = 0;
  private linkFree = 0;
  private async cost(bytes: number): Promise<void> {
    this.requests += 1;
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    // The link is one pipe: transfers queue for it, in parallel or not.
    const now = Date.now();
    const start = Math.max(now, this.linkFree);
    this.linkFree = start + (bytes * 8) / (LINK_MBIT * 1000);
    await new Promise((r) => setTimeout(r, this.linkFree - now));
  }
  async list(dir: string): Promise<RemoteEntry[]> {
    await this.cost(0);
    return [...this.files].filter(([p]) => p.startsWith(`${dir}/`)).map(([path, b]) => ({ path, rev: "r", size: b.length }));
  }
  async read(path: string): Promise<Uint8Array | null> {
    const file = this.files.get(path);
    await this.cost(file?.length ?? 0);
    return file?.slice() ?? null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.cost(bytes.length);
    this.files.set(path, bytes.slice());
  }
  async remove(path: string): Promise<void> {
    await this.cost(0);
    this.files.delete(path);
  }
}

const remote = new SlowFolder();
const { binding: vault } = await createVault(new SlowFolder());
const pages = Array.from({ length: PAGES }, (_, i) => {
  const page = new Uint8Array(PAGE_KB * 1024);
  for (let j = 0; j < page.length; j += 1) page[j] = (j * 131 + i * 7) & 0xff;
  return page;
});
const source: PackSource = {
  record: { id: "v", title: "bench", format: "manga", progress: 0, addedAt: 1, chapters: [] },
  manga: {
    record: { id: "v", pages: pages.map((_, i) => ({ path: `${i}.jpg` })) },
    page: async (i) => new Blob([pages[i]! as BlobPart], { type: "image/jpeg" }),
  },
};
const plan = (await planPack(source))!;
const dir = packDir("devA", await folderName(vault.keys, "m1:bench"));
const mb = (PAGES * PAGE_KB) / 1024;
console.log(`volume: ${PAGES} pages, ${mb.toFixed(0)} MB · latency ${LATENCY_MS} ms · link ${LINK_MBIT} Mbit/s`);
console.log(`floor (bytes over the link alone): ${((mb * 8) / LINK_MBIT).toFixed(1)} s`);

let t = Date.now();
remote.requests = 0;
await uploadPack(remote, vault, dir, plan, new Set(), Date.now() + 3_600_000);
console.log(`upload:   ${((Date.now() - t) / 1000).toFixed(1)} s, ${remote.requests} requests`);

t = Date.now();
remote.requests = 0;
const manifest = (await readManifest(remote, vault, dir))!;
await installPack(remote, vault, dir, manifest, "local", { progress: 0, addedAt: 2 });
console.log(`download: ${((Date.now() - t) / 1000).toFixed(1)} s, ${remote.requests} requests`);

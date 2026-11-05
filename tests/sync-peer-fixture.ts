// Browser-side fixture for sync-peer-smoke: real storage and WebRTC;
// only the sealed signaling folder is emulated by Playwright.
import { fetchFromPeer, servePeers } from "../src/components/sync/p2p";
import { loadMangaPageBlob, putMangaPageBlob } from "../src/core/storage";
import type { PackSource } from "../src/core/sync/book-pack";
import type { RemoteEntry, RemoteFolder } from "../src/core/sync/remote";
import type { VaultBinding } from "../src/core/sync/store";
import { createVault, unlockVault } from "../src/core/sync/vault";

const request = async (method: string, path: string, bytes?: Uint8Array) => {
  const response = await fetch(`/__peer_cloud?path=${encodeURIComponent(path)}`, {
    method,
    ...(bytes ? { body: new Blob([bytes as BlobPart]) } : {}),
  });
  if (!response.ok && response.status !== 404) throw new Error(`cloud: ${response.status}`);
  return response;
};
const remote: RemoteFolder = {
  kind: "memory",
  list: async (path) => {
    const entries: unknown = await (await request("POST", path)).json();
    if (!Array.isArray(entries)) throw new Error("invalid listing");
    return entries.map((entry: unknown): RemoteEntry => {
      if (typeof entry !== "object" || entry === null || !("path" in entry) || typeof entry.path !== "string"
        || !("rev" in entry) || typeof entry.rev !== "string" || !("size" in entry) || typeof entry.size !== "number") {
        throw new Error("invalid entry");
      }
      return { path: entry.path, rev: entry.rev, size: entry.size };
    });
  },
  read: async (path) => {
    const response = await request("GET", path);
    return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer());
  },
  write: async (path, bytes) => { await request("PUT", path, bytes); },
  remove: async (path) => { await request("DELETE", path); },
};
let vault: VaultBinding;
let me = "";
let stop = () => {};
const sources = new Map<string, PackSource>();
const connections = new Set<RTCPeerConnection>();
const PeerConnection = RTCPeerConnection;
window.RTCPeerConnection = class extends PeerConnection {
  constructor(config?: RTCConfiguration) { super(config); connections.add(this); }
};
export function closeConnections(): void { for (const connection of connections) connection.close(); }
export const faults = { dropAfter: Infinity, dropped: false };

export async function setup(id: string, recoveryKey?: string): Promise<string> {
  me = id;
  if (recoveryKey) {
    vault = await unlockVault(remote, recoveryKey);
    return recoveryKey;
  }
  const created = await createVault(remote);
  vault = created.binding;
  return created.recoveryKey;
}

export async function seed(key: string, pages = 32, pageBytes = 1024 * 1024, largeMetadata = false): Promise<void> {
  for (let page = 0; page < pages; page++) {
    const bytes = Uint8Array.from({ length: pageBytes }, (_, i) => (i * 17 + page) & 255);
    await putMangaPageBlob(key, page, new Blob([bytes], { type: "image/jpeg" }));
  }
  sources.set(key, {
    record: { id: key, title: key, format: "manga", progress: 0, addedAt: 1, chapters: [], ...(largeMetadata ? { cover: "雪".repeat(150_000) } : {}) },
    manga: {
      record: { id: key, pages: Array.from({ length: pages }, (_, i) => ({ path: `${i}.jpg` })) },
      page: (index) => loadMangaPageBlob(key, index),
    },
  });
}

export function serve(): void {
  stop = servePeers({
    remote: async () => remote,
    vault: async () => vault,
    me: async () => me,
    packSource: async (key) => sources.get(key) ?? null,
    idle: () => new Promise((resolve) => setTimeout(resolve, 100)),
  });
}

export async function download(key: string, id: string, peers = ["mac"]) {
  const started = performance.now();
  let firstByte = 0;
  let size = 0;
  const stages: string[] = [];
  await fetchFromPeer({
    remote, vault, peers, key, id,
    personal: { progress: 0.25, addedAt: 2 },
    onStage: (stage) => stages.push(stage),
    onProgress: (done) => {
      firstByte ||= performance.now();
      size = done;
      if (!faults.dropped && done >= faults.dropAfter) {
        faults.dropped = true;
        closeConnections();
      }
    },
  });
  const done = performance.now();
  return { connectMs: firstByte - started, transferMs: done - firstByte, totalMs: done - started, size, stages };
}

export async function verify(id: string, pages = 32, pageBytes = 1024 * 1024): Promise<void> {
  for (let page = 0; page < pages; page++) {
    const blob = await loadMangaPageBlob(id, page);
    if (!blob || blob.size !== pageBytes) throw new Error(`missing page ${page}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.every((byte, i) => byte === ((i * 17 + page) & 255))) throw new Error(`damaged page ${page}`);
  }
}

export function dispose(): void { stop(); }

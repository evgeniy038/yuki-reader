import { addStatsDelta, loadMangaPageBlob, loadShelfBooks, putBook, putMangaVolume, restoreBookProgress } from "../src/core/storage";
import { currentHost, getView, requestSync, subscribe } from "../src/components/sync/sync-controller";

const connections = new Set<RTCPeerConnection>();
let cloudBusy = false;
let cloudStatus = false;
let rounds = 0;
export function instrument(): void {
  subscribe(() => {
    cloudBusy ||= getView().syncing;
    cloudStatus ||= getView().status !== undefined;
  });
  window.addEventListener("yuki:sync-applied", () => rounds++);
  const Original = RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(options?: RTCConfiguration) { super(options); connections.add(this); }
  };
}
export const activity = () => ({ cloudBusy, cloudStatus, rounds });
export function dropConnection(): void {
  for (const pc of connections) pc.close();
  window.dispatchEvent(new Event("yuki-test:drop-peer"));
}

export async function seed(): Promise<void> {
  await putBook({ id: "novel", title: "Code-paired novel", format: "epub", language: "en", chapters: [{ id: "one", html: `<p>${"A book without a cloud account. ".repeat(500)}</p>` }], progress: 0.42, lastReadAt: Date.now() - 1000, addedAt: 1, favorite: true });
  await addStatsDelta({ chars: 1234, pages: 0, timeMs: 120_000 }, "novel");
  const blocks = [{ box: [0, 0, 10, 10] as [number, number, number, number], vertical: false, font_size: 10, lines: ["本文"] }];
  const pages = Array.from({ length: 32 }, (_, page) => ({ path: `${page}.jpg`, blocks }));
  const blobs = pages.map((_, page) => new Blob([Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 17 + page) & 255)], { type: "image/jpeg" }));
  await putMangaVolume({ id: "volume", pages }, blobs);
  await putBook({ id: "volume", title: "Wi-Fi volume", format: "manga", language: "ja", pageCount: 32, chapters: [], progress: 0.25, addedAt: 2 });
}

export async function readOnPhone(): Promise<void> {
  const book = (await loadShelfBooks()).find((book) => book.title === "Code-paired novel");
  if (!book) throw new Error("Novel never arrived");
  const lastReadAt = Date.now();
  await restoreBookProgress(book.id, 0.77, lastReadAt);
  await addStatsDelta({ chars: 321, pages: 0, timeMs: 60_000 }, book.id);
  currentHost()?.patch([{ id: book.id, key: "", progress: 0.77, lastReadAt }]);
  requestSync(0);
}

export async function verifyVolume(): Promise<void> {
  const book = (await loadShelfBooks()).find((book) => book.title === "Wi-Fi volume");
  if (!book) throw new Error("Volume never arrived");
  for (let page = 0; page < 32; page++) {
    const blob = await loadMangaPageBlob(book.id, page);
    if (!blob || blob.size !== 1024 * 1024) throw new Error(`Missing page ${page}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.every((byte, i) => byte === ((i * 17 + page) & 255))) throw new Error(`Damaged page ${page}`);
  }
}

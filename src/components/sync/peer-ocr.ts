import { OCR_ENGINE, putMangaOcrRecords, type MangaOcrRecord } from "@/core/storage";
import type { PackSource } from "@/core/sync/book-pack";
import { parseOcrPack } from "@/core/sync/model";
import { isReady, processingOf } from "@/core/sync/ready";
import { syncStore } from "@/core/sync/store";
import type { SyncHost } from "./sync-bridge";
import { forgetReadiness } from "./sync-ready";
import { peerMessages } from "./peer-messages";
import type { PeerLink } from "./peer-link";

/** New OCR can arrive independently of pages already on the phone. */
export function servePeerOcr(channel: RTCDataChannel, source: () => Promise<PackSource | null>): void {
  const messages = peerMessages(channel, () => {});
  const timer = setTimeout(() => channel.close(), 30_000);
  channel.addEventListener("close", () => { clearTimeout(timer); messages.dispose(); });
  const send = async () => {
    const manga = (await source())?.manga;
    const pages = new Map(manga?.ocr?.pages);
    manga?.record.pages.forEach((page, index) => { if (page.blocks?.length) pages.set(index, page.blocks); });
    await messages.send(manga ? { v: 1, engine: OCR_ENGINE, pages: Object.fromEntries(pages) } : null);
  };
  if (channel.readyState === "open") void send().catch(() => channel.close());
  else channel.addEventListener("open", () => { void send().catch(() => channel.close()); }, { once: true });
}

async function fetchOcr(link: PeerLink, key: string) {
  const channel = await link.channel(`yuki-ocr:${key}`);
  return new Promise<ReturnType<typeof parseOcrPack>>((resolve) => {
    const messages = peerMessages(channel, (value) => finish(parseOcrPack(value)));
    const finish = (pack?: ReturnType<typeof parseOcrPack>) => {
      clearTimeout(timer);
      messages.dispose();
      channel.removeEventListener("close", closed);
      channel.removeEventListener("error", closed);
      channel.close();
      resolve(pack?.engine === OCR_ENGINE ? pack : undefined);
    };
    const closed = () => finish();
    const timer = setTimeout(closed, 30_000);
    channel.addEventListener("close", closed);
    channel.addEventListener("error", closed);
  });
}

export async function syncPeerOcr(host: SyncHost, holder: (key: string) => PeerLink | undefined): Promise<void> {
  const keys = await syncStore.bookKeys();
  for (const book of host.books()) {
    if (book.format !== "manga") continue;
    const key = keys.get(book.id);
    const link = key ? holder(key) : undefined;
    if (!key || !link || isReady(await processingOf(book.id, "manga"))) continue;
    const pack = await fetchOcr(link, key).catch(() => undefined);
    if (!pack) continue;
    const records = new Map<number, MangaOcrRecord>();
    for (const [index, blocks] of pack.pages) records.set(index, { blocks, engine: OCR_ENGINE });
    await putMangaOcrRecords(book.id, records);
    forgetReadiness(book.id);
  }
}

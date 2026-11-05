import type { BookRecord } from "@/core/storage";
import { planPack, type PackSource } from "@/core/sync/book-pack";
import type { BookKey } from "@/core/sync/model";
import { parsePackManifest } from "@/core/sync/pack-shape";
import { createInstaller, PackError, streamPack, type PersonalState } from "@/core/sync/pack-stream";
import { ACK_EVERY, FRAME, MAX_METADATA, parseMessage, PeerUnreachableError, STALL_MS, WINDOW, type Message } from "./p2p-protocol";

export { ACK_EVERY, FRAME, WINDOW, parseMessage, PeerUnavailableError, PeerUnreachableError, type Message } from "./p2p-protocol";

// Bound both the browser's send queue and the receiver's storage backlog.
const HIGH_WATER = 4 * 1024 * 1024;
export type Wire = Pick<RTCDataChannel,
  "send" | "close" | "readyState" | "bufferedAmount" | "bufferedAmountLowThreshold" | "addEventListener" | "removeEventListener"
>;

/** Ask for a book; every exit removes listeners and unfinished storage. */
export function receiveBook(
  channel: Wire,
  opts: { key: BookKey; id: string; personal: PersonalState; onProgress: (done: number, total: number) => void },
): Promise<BookRecord> {
  return new Promise((resolve, reject) => {
    let installer: ReturnType<typeof createInstaller> | null = null;
    let metadata: Uint8Array | null = null;
    let metadataAt = 0;
    let total = 0;
    let acked = 0;
    let lastProgress = -Infinity;
    let stopped = false;
    let queue = Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onClose);
    };
    const fail = (error: unknown) => {
      if (stopped) return;
      stopped = true;
      cleanup();
      channel.close();
      // A storage write already in flight must finish before rollback.
      void queue.then(() => installer?.abort()).then(() => reject(error), reject);
    };
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new PeerUnreachableError()), STALL_MS);
    };
    const start = (value: unknown) => {
      const manifest = parsePackManifest(value);
      if (!manifest || installer) throw new PackError("The book manifest is damaged or repeated");
      total = manifest.size;
      installer = createInstaller(manifest, opts.id, opts.personal);
    };
    const consume = async (data: unknown) => {
      if (stopped) return;
      if (typeof data === "string") {
        const message = parseMessage(data);
        if (!message || metadata) throw new PackError("The other device sent something unexpected");
        if (message.t === "manifest") start(message.manifest);
        else if (message.t === "metadata") {
          if (installer) throw new PackError("The book manifest was repeated");
          metadata = new Uint8Array(message.size);
        } else if (message.t === "end") {
          if (!installer) throw new PackError("The book never started");
          const record = await installer.finish();
          if (!stopped) {
            stopped = true;
            cleanup();
            resolve(record);
          }
        } else if (message.t === "error") throw new PackError(message.reason || "The other device couldn't send the book");
        else throw new PackError("The book arrived out of order");
        return;
      }
      if (!(data instanceof ArrayBuffer)) throw new PackError("The book arrived out of order");
      if (metadata) {
        if (metadataAt + data.byteLength > metadata.length) throw new PackError("Too much book metadata");
        metadata.set(new Uint8Array(data), metadataAt);
        metadataAt += data.byteLength;
        if (metadataAt === metadata.length) {
          start(JSON.parse(new TextDecoder().decode(metadata)) as unknown);
          metadata = null;
        }
        return;
      }
      if (!installer) throw new PackError("The book arrived out of order");
      await installer.push(new Uint8Array(data));
      if (stopped) return;
      if (installer.received - acked >= ACK_EVERY || installer.received === total) {
        acked = installer.received;
        if (channel.readyState === "open") channel.send(JSON.stringify({ t: "ack", stored: acked } satisfies Message));
      }
      const now = Date.now();
      if (now - lastProgress >= 100 || installer.received === total) {
        lastProgress = now;
        opts.onProgress(installer.received, total);
      }
      touch();
    };
    const onMessage = (event: MessageEvent) => {
      touch();
      const data: unknown = event.data;
      queue = queue.then(() => consume(data)).catch(fail);
    };
    const onClose = () => {
      // An ordered "end" may already be queued behind storage writes.
      void queue.then(() => fail(new PeerUnreachableError()));
    };
    channel.addEventListener("message", onMessage);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onClose);
    touch();
    try {
      channel.send(JSON.stringify({ t: "get", key: opts.key, window: WINDOW, framed: true } satisfies Message));
    } catch (error) { fail(error); }
  });
}

/** A bounded wait wakes on progress, failure or close — never just drain. */
function room(channel: Wire, ready: () => boolean): Promise<void> {
  if (channel.readyState !== "open") return Promise.reject(new PeerUnreachableError());
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const events = ["bufferedamountlow", "message", "close", "error"];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      for (const event of events) channel.removeEventListener(event, check);
      if (error) reject(error);
      else resolve();
    };
    const check = (event: Event) => {
      if (channel.readyState !== "open" || event.type === "error") finish(new PeerUnreachableError());
      else if (ready()) finish();
    };
    const timer = setTimeout(() => finish(new PeerUnreachableError()), STALL_MS);
    for (const event of events) channel.addEventListener(event, check);
  });
}

export async function sendBook(
  channel: Wire,
  source: PackSource | null,
  window: number | undefined,
  options: { frame?: number; framed?: boolean } = {},
): Promise<void> {
  const plan = source ? await planPack(source) : null;
  if (!plan) {
    channel.send(JSON.stringify({ t: "error", reason: "That book isn't on this device any more" } satisfies Message));
    return;
  }
  const frame = Math.min(options.frame ?? FRAME, window ?? WINDOW);
  let sent = 0;
  let stored = 0;
  const onMessage = (event: MessageEvent) => {
    const message = typeof event.data === "string" ? parseMessage(event.data) : null;
    if (message?.t === "ack" && message.stored <= sent) stored = Math.max(stored, message.stored);
  };
  channel.addEventListener("message", onMessage);
  channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
  try {
    if (options.framed) {
      // Manga sidecars and covers can exceed SCTP's single-message limit.
      const metadata = new TextEncoder().encode(JSON.stringify(plan.manifest));
      if (metadata.length > MAX_METADATA) throw new PackError("The book metadata is too large");
      channel.send(JSON.stringify({ t: "metadata", size: metadata.length } satisfies Message));
      for (let at = 0; at < metadata.length; at += frame) await sendFrame(channel, metadata.subarray(at, at + frame));
    } else {
      channel.send(JSON.stringify({ t: "manifest", manifest: plan.manifest } satisfies Message));
    }
    await streamPack(plan, frame, async (bytes) => {
      await room(channel, () => window === undefined || sent + bytes.length - stored <= window);
      await sendFrame(channel, bytes);
      sent += bytes.length;
    });
    channel.send(JSON.stringify({ t: "end" } satisfies Message));
  } finally {
    channel.removeEventListener("message", onMessage);
  }
}

async function sendFrame(channel: Wire, bytes: Uint8Array): Promise<void> {
  await room(channel, () => channel.bufferedAmount <= HIGH_WATER);
  // send() copies synchronously; don't copy the frame once more ourselves.
  channel.send(bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes.slice());
}

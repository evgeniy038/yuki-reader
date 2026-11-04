import type { BookRecord } from "@/core/storage";
import { planPack, type PackSource } from "@/core/sync/book-pack";
import type { BookKey } from "@/core/sync/model";
import { parsePackManifest, type PackManifest } from "@/core/sync/pack-shape";
import { createInstaller, streamPack, type PersonalState } from "@/core/sync/pack-stream";

// The wire of a direct transfer (p2p.ts sets the connection up): the asker
// sends "get", the holder a manifest, the pack stream in frames and "end".
// Two brakes keep memory flat on both ends — the channel's own send buffer
// (HIGH_WATER) and the asker's acknowledgements of what it has STORED
// (WINDOW): a phone writes to storage slower than Wi-Fi delivers, and
// without them a 300 MB volume would pile up in its page's memory.

/** Data-channel message size — safe in every browser's SCTP stack. */
export const FRAME = 64 * 1024;
/** Stop queueing while this much is still unsent (memory + fairness). */
const HIGH_WATER = 4 * 1024 * 1024;
/** The receiver stores what arrives (storage writes are slower than Wi-Fi
    on a phone) and says how far it got every ACK_EVERY bytes; the sender
    stays within WINDOW of that — so a 300 MB volume never piles up in the
    receiving page's memory waiting to be written. */
export const WINDOW = 16 * 1024 * 1024;
export const ACK_EVERY = 1024 * 1024;
/** What a transfer needs of a data channel (an in-memory one in tests). */
export type Wire = Pick<
  RTCDataChannel,
  "send" | "close" | "readyState" | "bufferedAmount" | "bufferedAmountLowThreshold" | "addEventListener" | "removeEventListener"
>;

/** No device answered the doorbell (yuki isn't open on any of them). */
export class PeerUnavailableError extends Error {
  constructor() {
    super("The other device didn't answer");
    this.name = "PeerUnavailableError";
  }
}

/** A device answered, but no direct connection came up (different networks
    behind strict routers, or a VPN in the way). */
export class PeerUnreachableError extends Error {
  constructor() {
    super("The other device answered but couldn't be reached directly");
    this.name = "PeerUnreachableError";
  }
}

export type Message =
  // `window`: the asker acknowledges what it stored (older versions don't).
  | { t: "get"; key: BookKey; window?: number }
  | { t: "ack"; stored: number }
  | { t: "manifest"; manifest: PackManifest }
  | { t: "end" }
  | { t: "error"; reason: string };

export function parseMessage(text: string): Message | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("t" in value)) return null;
  if (value.t === "get" && "key" in value && typeof value.key === "string") {
    const window = "window" in value && typeof value.window === "number" && value.window > 0 ? value.window : undefined;
    return window ? { t: "get", key: value.key, window } : { t: "get", key: value.key };
  }
  if (value.t === "ack" && "stored" in value && typeof value.stored === "number") return { t: "ack", stored: value.stored };
  if (value.t === "manifest" && "manifest" in value) {
    const manifest = parsePackManifest(value.manifest);
    return manifest ? { t: "manifest", manifest } : null;
  }
  if (value.t === "end") return { t: "end" };
  if (value.t === "error") return { t: "error", reason: "reason" in value && typeof value.reason === "string" ? value.reason : "" };
  return null;
}

/** Ask for the book on an open channel and store it as `id`. */
export function receiveBook(
  channel: Wire,
  opts: { key: BookKey; id: string; personal: PersonalState; onProgress: (done: number, total: number) => void },
): Promise<BookRecord> {
  return new Promise<BookRecord>((resolve, reject) => {
    let installer: ReturnType<typeof createInstaller> | null = null;
    let total = 0;
    let acked = 0;
    // Messages are handled strictly in order: storage writes are async.
    let queue = Promise.resolve();
    const fail = (error: unknown) => {
      reject(error);
      channel.close();
    };
    channel.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      queue = queue
        .then(async () => {
          if (typeof data === "string") {
            const message = parseMessage(data);
            if (!message) throw new Error("The other device sent something unexpected");
            if (message.t === "manifest") {
              total = message.manifest.size;
              installer = createInstaller(message.manifest, opts.id, opts.personal);
            } else if (message.t === "end") {
              if (!installer) throw new Error("The book never started");
              resolve(await installer.finish());
            } else if (message.t === "error") {
              throw new Error(message.reason || "The other device couldn't send the book");
            }
            return;
          }
          if (!(data instanceof ArrayBuffer) || !installer) throw new Error("The book arrived out of order");
          await installer.push(new Uint8Array(data));
          if (installer.received - acked >= ACK_EVERY || installer.received === total) {
            acked = installer.received;
            channel.send(JSON.stringify({ t: "ack", stored: acked } satisfies Message));
          }
          opts.onProgress(installer.received, total);
        })
        .catch(async (error: unknown) => {
          await installer?.abort();
          fail(error);
        });
    });
    channel.addEventListener("close", () => {
      void queue.then(() => fail(new PeerUnavailableError()));
    });
    channel.send(JSON.stringify({ t: "get", key: opts.key, window: WINDOW } satisfies Message));
  });
}

/** Send one book down an open channel, respecting its buffer — and, when
    the asker acknowledges, staying within `window` of what it stored. */
export async function sendBook(channel: Wire, source: PackSource | null, window: number | undefined): Promise<void> {
  const plan = source ? await planPack(source) : null;
  if (!plan) {
    channel.send(JSON.stringify({ t: "error", reason: "That book isn't on this device any more" } satisfies Message));
    return;
  }
  let sent = 0;
  let stored = 0;
  let wake = () => {};
  const onMessage = (event: MessageEvent) => {
    const message = typeof event.data === "string" ? parseMessage(event.data) : null;
    if (message?.t === "ack") {
      stored = Math.max(stored, message.stored);
      wake();
    }
  };
  const onClose = () => wake();
  channel.addEventListener("message", onMessage);
  channel.addEventListener("close", onClose);
  channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
  channel.send(JSON.stringify({ t: "manifest", manifest: plan.manifest } satisfies Message));
  try {
    await streamPack(plan, FRAME, async (bytes) => {
      while (window !== undefined && sent + bytes.length - stored > window && channel.readyState === "open") {
        await new Promise<void>((resolve) => (wake = resolve));
      }
      await sendFrame(channel, bytes);
      sent += bytes.length;
    });
  } finally {
    channel.removeEventListener("message", onMessage);
    channel.removeEventListener("close", onClose);
  }
  channel.send(JSON.stringify({ t: "end" } satisfies Message));
}

/** One frame, once the channel's own send buffer has room. */
async function sendFrame(channel: Wire, bytes: Uint8Array): Promise<void> {
  if (channel.readyState !== "open") throw new Error("The other device left");
  if (channel.bufferedAmount > HIGH_WATER) {
    await new Promise<void>((resolve) =>
      channel.addEventListener("bufferedamountlow", () => resolve(), { once: true }),
    );
  }
  channel.send(bytes.slice()); // its own buffer: the view may share a page's
}

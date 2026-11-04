import type { BookRecord } from "@/core/storage";
import { planPack, type PackSource } from "@/core/sync/book-pack";
import { parsePackManifest, type PackManifest } from "@/core/sync/pack-shape";
import { createInstaller, streamPack, type PersonalState } from "@/core/sync/pack-stream";
import type { BookKey } from "@/core/sync/model";
import type { RemoteFolder } from "@/core/sync/remote";
import { answerPath, OFFER, offerPath, readSignal, writeSignal } from "@/core/sync/signal";
import type { VaultBinding } from "@/core/sync/store";

// Books straight from one device to another — no cloud storage, no size
// limit, at the speed of the home Wi-Fi. The cloud only rings the doorbell
// (core/sync/signal.ts: sealed WebRTC offer/answer); the book itself goes
// over a WebRTC data channel (DTLS-encrypted, its fingerprints vouched for
// by the sealed signals) as the same stream a cloud pack is made of, and
// lands in storage file by file as it arrives. Both devices must have yuki
// open while it moves.

const ICE: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
/** Data-channel message size — safe in every browser's SCTP stack. */
const FRAME = 64 * 1024;
/** Stop queueing while this much is still unsent (memory + fairness). */
const HIGH_WATER = 4 * 1024 * 1024;
const ANSWER_WAIT_MS = 90_000;
const OPEN_WAIT_MS = 20_000;

export class PeerUnavailableError extends Error {
  constructor() {
    super("The other device didn't answer");
    this.name = "PeerUnavailableError";
  }
}

type Message =
  | { t: "get"; key: BookKey }
  | { t: "manifest"; manifest: PackManifest }
  | { t: "end" }
  | { t: "error"; reason: string };

function parseMessage(text: string): Message | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("t" in value)) return null;
  if (value.t === "get" && "key" in value && typeof value.key === "string") return { t: "get", key: value.key };
  if (value.t === "manifest" && "manifest" in value) {
    const manifest = parsePackManifest(value.manifest);
    return manifest ? { t: "manifest", manifest } : null;
  }
  if (value.t === "end") return { t: "end" };
  if (value.t === "error") return { t: "error", reason: "reason" in value && typeof value.reason === "string" ? value.reason : "" };
  return null;
}

/** Wait for ICE gathering to finish (or a few seconds — a slow STUN server
    must not hold the doorbell: on one Wi-Fi the local candidates suffice). */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = window.setTimeout(done, 3_000);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask `peer` for book `key` and store it as `id`. Throws
    PeerUnavailableError when the other device doesn't pick up in time. */
export async function fetchFromPeer(opts: {
  remote: RemoteFolder;
  vault: VaultBinding;
  me: string;
  peer: string;
  key: BookKey;
  id: string;
  personal: PersonalState;
  /** The other device hasn't answered after a few seconds (closed?). */
  onWaiting: () => void;
  onProgress: (done: number, total: number) => void;
}): Promise<BookRecord> {
  const { remote, vault, me, peer } = opts;
  const pc = new RTCPeerConnection(ICE);
  const channel = pc.createDataChannel("yuki-book", { ordered: true });
  channel.binaryType = "arraybuffer";
  const session = crypto.randomUUID();
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    await writeSignal(remote, vault, offerPath(me, peer), {
      v: 1,
      session,
      sdp: pc.localDescription?.sdp ?? "",
      at: Date.now(),
    });
    const started = Date.now();
    let warned = false;
    for (;;) {
      const answer = await readSignal(remote, vault, answerPath(peer, me));
      if (answer?.session === session) {
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        break;
      }
      if (!warned && Date.now() - started > 4_000) {
        warned = true;
        opts.onWaiting();
      }
      if (Date.now() - started > ANSWER_WAIT_MS) throw new PeerUnavailableError();
      await sleep(1_000);
    }
    await new Promise<void>((resolve, reject) => {
      if (channel.readyState === "open") return resolve();
      const timer = window.setTimeout(() => reject(new PeerUnavailableError()), OPEN_WAIT_MS);
      channel.addEventListener("open", () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });

    return await new Promise<BookRecord>((resolve, reject) => {
      let installer: ReturnType<typeof createInstaller> | null = null;
      let total = 0;
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
      channel.send(JSON.stringify({ t: "get", key: opts.key } satisfies Message));
    });
  } finally {
    pc.close();
    void remote.remove(offerPath(me, peer)).catch(() => {});
  }
}

/** Send one book down an open channel, respecting its buffer. */
async function sendBook(channel: RTCDataChannel, source: PackSource | null): Promise<void> {
  const plan = source ? await planPack(source) : null;
  if (!plan) {
    channel.send(JSON.stringify({ t: "error", reason: "That book isn't on this device any more" } satisfies Message));
    return;
  }
  channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
  channel.send(JSON.stringify({ t: "manifest", manifest: plan.manifest } satisfies Message));
  await streamPack(plan, FRAME, async (bytes) => {
    if (channel.readyState !== "open") throw new Error("The other device left");
    if (channel.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((resolve) =>
        channel.addEventListener("bufferedamountlow", () => resolve(), { once: true }),
      );
    }
    channel.send(bytes.slice()); // its own buffer: the view may share a page's
  });
  channel.send(JSON.stringify({ t: "end" } satisfies Message));
}

/** Answer other devices' doorbells and serve the books they ask for while
    this page is open. `wake` resolves when signal/ may have changed (a
    long-poll where the cloud has one, a short timer otherwise). */
export function servePeers(opts: {
  remote: () => Promise<RemoteFolder | null>;
  vault: () => Promise<VaultBinding | undefined>;
  me: () => Promise<string>;
  packSource: (key: BookKey) => Promise<PackSource | null>;
  wake: (remote: RemoteFolder, signal: AbortSignal) => Promise<void>;
}): () => void {
  const abort = new AbortController();
  const answered = new Set<string>();
  const peers = new Set<RTCPeerConnection>();

  const answer = async (remote: RemoteFolder, vault: VaultBinding, me: string, from: string, path: string) => {
    const offer = await readSignal(remote, vault, path);
    if (!offer || answered.has(offer.session)) return;
    answered.add(offer.session);
    const pc = new RTCPeerConnection(ICE);
    peers.add(pc);
    const drop = () => {
      pc.close();
      peers.delete(pc);
    };
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") drop();
    });
    pc.addEventListener("datachannel", (event) => {
      const channel = event.channel;
      channel.binaryType = "arraybuffer";
      channel.addEventListener("message", (message: MessageEvent) => {
        if (typeof message.data !== "string") return;
        const request = parseMessage(message.data);
        if (request?.t !== "get") return;
        void opts
          .packSource(request.key)
          .then((source) => sendBook(channel, source))
          .catch(() => channel.close());
      });
      channel.addEventListener("close", drop);
    });
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await writeSignal(remote, vault, answerPath(me, from), {
      v: 1,
      session: offer.session,
      sdp: pc.localDescription?.sdp ?? "",
      at: Date.now(),
    });
    // Nobody connected within a minute: give the slot back.
    window.setTimeout(() => {
      if (pc.connectionState !== "connected") drop();
    }, 60_000);
  };

  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const [remote, vault, me] = await Promise.all([opts.remote(), opts.vault(), opts.me()]);
        if (!remote || !vault) {
          await sleep(10_000);
          continue;
        }
        for (const entry of await remote.list("signal")) {
          const match = OFFER.exec(entry.path);
          if (match && match[2] === me && match[1] !== me) await answer(remote, vault, me, match[1]!, entry.path);
        }
        await opts.wake(remote, abort.signal);
      } catch {
        await sleep(5_000);
      }
    }
  })();

  return () => {
    abort.abort();
    for (const pc of peers) pc.close();
    peers.clear();
  };
}

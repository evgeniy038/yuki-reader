import type { BookRecord } from "@/core/storage";
import type { PackSource } from "@/core/sync/book-pack";
import type { PersonalState } from "@/core/sync/pack-stream";
import type { BookKey } from "@/core/sync/model";
import type { RemoteFolder } from "@/core/sync/remote";
import { answerPath, OFFER, offerPath, readSignal, writeSignal } from "@/core/sync/signal";
import type { VaultBinding } from "@/core/sync/store";
import { parseMessage, PeerUnavailableError, PeerUnreachableError, receiveBook, sendBook } from "./p2p-wire";

export { PeerUnavailableError, PeerUnreachableError } from "./p2p-wire";

// Books straight from one device to another — no cloud storage, no size
// limit, at the speed of the home Wi-Fi. The cloud only rings the doorbell
// (core/sync/signal.ts: sealed WebRTC offer/answer); the book itself goes
// over a WebRTC data channel (DTLS-encrypted, its fingerprints vouched for
// by the sealed signals) as the same stream a cloud pack is made of, and
// lands in storage file by file as it arrives. Both devices must have yuki
// open while it moves.

const ICE: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const ANSWER_WAIT_MS = 90_000;
/** No answer this long: the other device is most likely closed — say so.
    Not sooner: over a VPN every cloud request costs ~0.5–0.9 s, and a ring
    that IS answered takes 5–10 s to come back. */
const CLOSED_AFTER_MS = 20_000;
const OPEN_WAIT_MS = 20_000;

/** Where a direct transfer stands before the first byte. */
export type DirectStage = "ringing" | "closed" | "connecting";

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

interface Call {
  peer: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
}

/** Poll every rung device's answer until one comes back for `session`. */
async function firstAnswer(
  remote: RemoteFolder,
  vault: VaultBinding,
  me: string,
  session: string,
  calls: Call[],
  onClosed: () => void,
): Promise<Call> {
  const started = Date.now();
  let warned = false;
  for (;;) {
    for (const call of calls) {
      const answer = await readSignal(remote, vault, answerPath(call.peer, me));
      if (answer?.session === session) {
        await call.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        return call;
      }
    }
    const waited = Date.now() - started;
    if (!warned && waited > CLOSED_AFTER_MS) {
      warned = true;
      onClosed();
    }
    if (waited > ANSWER_WAIT_MS) throw new PeerUnavailableError();
    await sleep(1_000);
  }
}

/** The channel opens, or the connection fails / takes too long. */
function opened({ pc, channel }: Call): Promise<void> {
  return new Promise((resolve, reject) => {
    if (channel.readyState === "open") return resolve();
    const fail = () => {
      window.clearTimeout(timer);
      reject(new PeerUnreachableError());
    };
    const timer = window.setTimeout(fail, OPEN_WAIT_MS);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") fail();
    });
    channel.addEventListener("open", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Ask the devices in `peers` for book `key` — every one is rung at once,
    the first to answer sends it — and store it as `id`. Throws
    PeerUnavailableError when none picks up in time, PeerUnreachableError
    when one does but no direct connection comes up. */
export async function fetchFromPeer(opts: {
  remote: RemoteFolder;
  vault: VaultBinding;
  me: string;
  peers: string[];
  key: BookKey;
  id: string;
  personal: PersonalState;
  onStage: (stage: DirectStage) => void;
  onProgress: (done: number, total: number) => void;
}): Promise<BookRecord> {
  const { remote, vault, me } = opts;
  const session = crypto.randomUUID();
  const calls: Call[] = opts.peers.map((peer) => {
    const pc = new RTCPeerConnection(ICE);
    const channel = pc.createDataChannel("yuki-book", { ordered: true });
    channel.binaryType = "arraybuffer";
    return { peer, pc, channel };
  });
  try {
    opts.onStage("ringing");
    await Promise.all(
      calls.map(async ({ peer, pc }) => {
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        await writeSignal(remote, vault, offerPath(me, peer), {
          v: 1,
          session,
          sdp: pc.localDescription?.sdp ?? "",
          at: Date.now(),
        });
      }),
    );
    const call = await firstAnswer(remote, vault, me, session, calls, () => opts.onStage("closed"));
    for (const other of calls) if (other !== call) other.pc.close();
    opts.onStage("connecting");
    await opened(call);
    return await receiveBook(call.channel, opts);
  } finally {
    for (const { peer, pc } of calls) {
      pc.close();
      void remote.remove(offerPath(me, peer)).catch(() => {});
    }
  }
}

/** Answer other devices' doorbells and serve the books they ask for while
    this page is open. Between looks it waits on the cloud's watch when it
    has one (armed before each look, so no doorbell slips in between), on
    `idle` otherwise. */
export function servePeers(opts: {
  remote: () => Promise<RemoteFolder | null>;
  vault: () => Promise<VaultBinding | undefined>;
  me: () => Promise<string>;
  packSource: (key: BookKey) => Promise<PackSource | null>;
  idle: () => Promise<void>;
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
          .then((source) => sendBook(channel, source, request.window))
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
        const changed = remote.watch ? await remote.watch("signal") : null;
        for (const entry of await remote.list("signal")) {
          const match = OFFER.exec(entry.path);
          if (match && match[2] === me && match[1] !== me) await answer(remote, vault, me, match[1]!, entry.path);
        }
        await (changed ? changed(abort.signal) : opts.idle());
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

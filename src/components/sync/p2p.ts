import type { BookRecord } from "@/core/storage";
import type { PackSource } from "@/core/sync/book-pack";
import type { PersonalState } from "@/core/sync/pack-stream";
import type { BookKey } from "@/core/sync/model";
import { AuthRequiredError, QuotaError, type RemoteFolder } from "@/core/sync/remote";
import { answerPath, OFFER, offerPath, readSignal, writeSignal, type Signal } from "@/core/sync/signal";
import type { VaultBinding } from "@/core/sync/store";
import { abortable, gathered, ICE, opened, pause } from "./p2p-connection";
import { FRAME, parseMessage, PeerUnavailableError, PeerUnreachableError, receiveBook, sendBook } from "./p2p-wire";

export { PeerUnavailableError, PeerUnreachableError } from "./p2p-wire";

// The cloud carries only sealed SDP; book bytes travel over DTLS/SCTP.
// Each call has its own return address, so simultaneous downloads and tabs
// cannot overwrite one another's offers, answers or cleanup.
const ANSWER_WAIT_MS = 90_000;
const CLOSED_AFTER_MS = 20_000;
export type DirectStage = "ringing" | "closed" | "connecting";

interface FetchOptions {
  remote: RemoteFolder;
  vault: VaultBinding;
  peers: string[];
  key: BookKey;
  id: string;
  personal: PersonalState;
  onStage: (stage: DirectStage) => void;
  onProgress: (done: number, total: number) => void;
}

interface Call {
  peer: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
}

async function publish(remote: RemoteFolder, vault: VaultBinding, path: string, value: Signal, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const write = writeSignal(remote, vault, path, value);
      // A timed-out cloud request may finish after its call was abandoned.
      void write.then(() => {
        if (signal.aborted) void remote.remove(path).catch(() => {});
      }, () => {});
      await abortable(write, signal);
      return;
    } catch (error) {
      if (signal.aborted || error instanceof AuthRequiredError || error instanceof QuotaError || attempt >= 2) throw error;
      await pause(300 * 2 ** attempt, signal);
    }
  }
}

/** Race open channels, not answers: an unreachable device can't win. */
async function connect(opts: FetchOptions): Promise<Call> {
  if (opts.peers.length === 0) throw new PeerUnavailableError();
  const session = crypto.randomUUID();
  const abort = new AbortController();
  const { signal } = abort;
  const { remote, vault } = opts;
  const calls: Call[] = [...new Set(opts.peers)].map((peer) => {
    const pc = new RTCPeerConnection(ICE);
    const channel = pc.createDataChannel("yuki-book", { ordered: true });
    channel.binaryType = "arraybuffer";
    return { peer, pc, channel };
  });
  let answered = false;
  let winner: Call | undefined;
  const warning = setTimeout(() => { if (!answered) opts.onStage("closed"); }, CLOSED_AFTER_MS);
  const deadline = setTimeout(() => abort.abort(answered ? new PeerUnreachableError() : new PeerUnavailableError()), ANSWER_WAIT_MS);
  opts.onStage("ringing");
  const jobs = calls.map(async (call) => {
    const path = offerPath(session, call.peer);
    try {
      await call.pc.setLocalDescription(await call.pc.createOffer());
      await gathered(call.pc, signal);
      await publish(remote, vault, path, { v: 1, session, sdp: call.pc.localDescription?.sdp ?? "", at: Date.now() }, signal);
      while (!signal.aborted) {
        const answer = await abortable(readSignal(remote, vault, answerPath(call.peer, session)).catch((error: unknown) => {
          if (error instanceof AuthRequiredError) throw error;
          return null;
        }), signal);
        if (answer?.session === session) {
          answered = true;
          opts.onStage("connecting");
          await call.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
          await opened(call.pc, call.channel, signal);
          return call;
        }
        await pause(300, signal);
      }
      signal.throwIfAborted();
      throw new PeerUnavailableError();
    } finally {
      void remote.remove(path).catch(() => {});
    }
  });
  try {
    winner = await Promise.any(jobs);
    return winner;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof AggregateError) {
      const permanent: unknown = error.errors.find((e: unknown) => e instanceof AuthRequiredError || e instanceof QuotaError);
      if (permanent) throw permanent;
    }
    // Only the answer deadline means nobody is there; failed signaling can
    // recover on the next connection attempt, just like a broken channel.
    throw new PeerUnreachableError();
  } finally {
    clearTimeout(warning);
    clearTimeout(deadline);
    abort.abort(new PeerUnreachableError());
    for (const call of calls) if (call !== winner) call.pc.close();
    // Delete the ephemeral folder too, so future polls don't scan empty calls.
    void Promise.allSettled(jobs).then(async () => {
      await Promise.allSettled(calls.map((call) => remote.remove(answerPath(call.peer, session))));
      await remote.remove(`signal/${session}`);
    }).catch(() => {});
  }
}

/** A broken direct link gets a fresh connection and a clean installation. */
export async function fetchFromPeer(opts: FetchOptions): Promise<BookRecord> {
  for (let attempt = 0; ; attempt++) {
    let call: Call | undefined;
    try {
      call = await connect(opts);
      return await receiveBook(call.channel, opts);
    } catch (error) {
      if (!(error instanceof PeerUnreachableError) || attempt >= 2) throw error;
      opts.onProgress(0, 1);
    } finally {
      call?.pc.close();
    }
  }
}

/** Serve independent offers concurrently; unchanged signals are never
    downloaded again, and a failed answer stays eligible for retry. */
export function servePeers(opts: {
  remote: () => Promise<RemoteFolder | null>;
  vault: () => Promise<VaultBinding | undefined>;
  me: () => Promise<string>;
  packSource: (key: BookKey) => Promise<PackSource | null>;
  idle: () => Promise<void>;
}): () => void {
  const abort = new AbortController();
  const { signal } = abort;
  const seen = new Map<string, string>();
  const pending = new Set<string>();
  const peers = new Set<() => void>();

  const answer = async (remote: RemoteFolder, vault: VaultBinding, me: string, from: string, path: string) => {
    const offer = await abortable(readSignal(remote, vault, path), signal);
    if (!offer) return;
    signal.throwIfAborted();
    const pc = new RTCPeerConnection(ICE);
    const callAbort = new AbortController();
    const callSignal = AbortSignal.any([signal, callAbort.signal]);
    let dropped = false;
    let timer: ReturnType<typeof setTimeout>;
    const reply = answerPath(me, from);
    const drop = () => {
      if (dropped) return;
      dropped = true;
      clearTimeout(timer);
      callAbort.abort(new PeerUnreachableError());
      pc.close();
      peers.delete(drop);
      void remote.remove(reply).catch(() => {});
    };
    peers.add(drop);
    timer = setTimeout(drop, 60_000);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") drop();
    });
    pc.addEventListener("datachannel", (event) => {
      const channel = event.channel;
      channel.binaryType = "arraybuffer";
      let requested = false;
      channel.addEventListener("message", (message: MessageEvent) => {
        const request = typeof message.data === "string" ? parseMessage(message.data) : null;
        if (request?.t !== "get" || requested) return;
        requested = true;
        clearTimeout(timer);
        const frame = Math.min(256 * 1024, pc.sctp?.maxMessageSize || FRAME);
        void opts.packSource(request.key)
          .then((source) => sendBook(channel, source, request.window, { frame, framed: request.framed }))
          .then(() => { if (!dropped) timer = setTimeout(drop, 30_000); })
          .catch(drop);
      });
      channel.addEventListener("close", drop);
      channel.addEventListener("error", drop);
    });
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, callSignal);
      await publish(remote, vault, reply, { v: 1, session: offer.session, sdp: pc.localDescription?.sdp ?? "", at: Date.now() }, callSignal);
      if (dropped) throw new PeerUnreachableError();
    } catch (error) {
      drop();
      throw error;
    }
  };

  void (async () => {
    while (!signal.aborted) {
      try {
        const [remote, vault, me] = await abortable(Promise.all([opts.remote(), opts.vault(), opts.me()]), signal);
        if (!remote || !vault) { await pause(10_000, signal); continue; }
        const changed = remote.watch ? await abortable(remote.watch("signal"), signal) : null;
        const entries = await abortable(remote.list("signal"), signal);
        const paths = new Set(entries.map((entry) => entry.path));
        for (const path of seen.keys()) if (!paths.has(path)) seen.delete(path);
        for (const entry of entries) {
          const match = OFFER.exec(entry.path);
          if (!match || match[2] !== me || match[1] === me || seen.get(entry.path) === entry.rev || pending.has(entry.path)) continue;
          pending.add(entry.path);
          void answer(remote, vault, me, match[1]!, entry.path)
            .then(() => seen.set(entry.path, entry.rev), () => {})
            .finally(() => pending.delete(entry.path));
        }
        await abortable(changed ? changed(signal) : opts.idle(), signal);
      } catch {
        await pause(5_000, signal);
      }
    }
  })();

  return () => {
    abort.abort(new PeerUnreachableError());
    for (const drop of peers) drop();
  };
}

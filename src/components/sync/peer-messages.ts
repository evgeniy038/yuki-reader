import { PeerUnreachableError } from "./p2p-protocol";

const FRAME = 32 * 1024;
const MAX_MESSAGE = 64 * 1024 * 1024;

/** Ordered, bounded frames: a library's covers needn't fit in one SCTP
    message. A single queue prevents two snapshots interleaving. */
export function peerMessages(channel: RTCDataChannel, onMessage: (value: unknown) => Promise<void> | void) {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 256 * 1024;
  let outgoing = Promise.resolve();
  let incoming = Promise.resolve();
  let bytes: Uint8Array | undefined;
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const broken = () => { clearTimeout(timer); channel.close(); };
  const onData = (event: MessageEvent) => {
    clearTimeout(timer);
    const data: unknown = event.data;
    try {
      if (typeof data === "string") {
        const size = Number(data);
        if (bytes || !Number.isSafeInteger(size) || size < 1 || size > MAX_MESSAGE) return broken();
        bytes = new Uint8Array(size);
        offset = 0;
      } else if (data instanceof ArrayBuffer && bytes && data.byteLength <= bytes.length - offset) {
        bytes.set(new Uint8Array(data), offset);
        offset += data.byteLength;
        if (offset === bytes.length) {
          const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
          bytes = undefined;
          incoming = incoming.then(() => onMessage(value)).catch(broken);
        }
      } else return broken();
      if (bytes) timer = setTimeout(broken, 30_000);
    } catch { broken(); }
  };
  channel.addEventListener("message", onData);
  const drain = (): Promise<void> => {
    if (channel.readyState !== "open") return Promise.reject(new PeerUnreachableError());
    if (channel.bufferedAmount < 1024 * 1024) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(deadline);
        for (const event of ["bufferedamountlow", "close", "error"]) channel.removeEventListener(event, done);
        if (channel.readyState === "open" && channel.bufferedAmount < 1024 * 1024) resolve();
        else reject(new PeerUnreachableError());
      };
      const deadline = setTimeout(done, 30_000);
      for (const event of ["bufferedamountlow", "close", "error"]) channel.addEventListener(event, done);
    });
  };
  return {
    send(value: unknown): Promise<void> {
      const task = outgoing.then(async () => {
        const packet = new TextEncoder().encode(JSON.stringify(value));
        if (packet.length > MAX_MESSAGE) throw new Error("Sync metadata is too large");
        await drain();
        channel.send(String(packet.length));
        for (let at = 0; at < packet.length; at += FRAME) {
          await drain();
          channel.send(packet.subarray(at, at + FRAME));
        }
      });
      outgoing = task.catch(() => {});
      return task;
    },
    dispose() {
      clearTimeout(timer);
      channel.removeEventListener("message", onData);
      bytes = undefined;
    },
  };
}

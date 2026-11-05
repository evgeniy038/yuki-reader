import { PeerUnreachableError } from "./p2p-protocol";

export const ICE: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

/** Stop waiting immediately when another peer wins or the attempt expires. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

/** Allow local candidates even when the STUN service is slow. */
export function gathered(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const timer = setTimeout(done, 3_000);
    pc.addEventListener("icegatheringstatechange", check);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

export function opened(pc: RTCPeerConnection, channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: unknown) => {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", check);
      for (const event of ["open", "close", "error"]) channel.removeEventListener(event, check);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => done(signal.reason);
    const check = (event?: Event) => {
      if (signal.aborted) abort();
      else if (channel.readyState === "open") done();
      else if (event?.type === "error" || channel.readyState === "closed" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        done(new PeerUnreachableError());
      }
    };
    const timer = setTimeout(() => done(new PeerUnreachableError()), 20_000);
    pc.addEventListener("connectionstatechange", check);
    for (const event of ["open", "close", "error"]) channel.addEventListener(event, check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

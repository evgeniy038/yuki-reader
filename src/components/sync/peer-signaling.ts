import { PeerUnreachableError } from "./p2p-protocol";
import { decodeSignal, encodeSignal, type signalingSecret } from "./peer-secret";

/** The rendezvous socket can reconnect without touching the direct transport. */
export class PeerSignaling {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private attempts = 0;
  private pingAt = 0;
  private tickAt = 0;
  private received = Promise.resolve();
  private sent = Promise.resolve();
  ready = false;

  constructor(
    private readonly credentials: Awaited<ReturnType<typeof signalingSecret>>,
    private readonly side: 0 | 1,
    private readonly temporary: boolean,
    private readonly signal: AbortSignal,
    private readonly onReady: () => void,
    private readonly onMessage: (value: unknown) => Promise<void>,
    private readonly onResume: () => void,
  ) {
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      // Time spent suspended is not evidence of an unanswered heartbeat.
      this.pingAt = 0;
      this.tickAt = Date.now();
      if (!this.socket || this.socket.readyState >= WebSocket.CLOSING) this.connect();
      else this.probe();
      this.onResume();
    };
    document.addEventListener("visibilitychange", resume, { signal });
    window.addEventListener("pageshow", resume, { signal });
    window.addEventListener("online", resume, { signal });
    signal.addEventListener("abort", () => {
      clearTimeout(this.retry);
      clearInterval(this.heartbeat);
      this.socket?.close();
    }, { once: true });
    this.connect();
  }

  send(value: unknown): Promise<void> {
    const socket = this.socket;
    const task = this.sent.then(async () => {
      if (!socket || socket.readyState !== WebSocket.OPEN || this.signal.aborted) throw new PeerUnreachableError();
      const encrypted = await encodeSignal(this.credentials.key, value);
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) throw new PeerUnreachableError();
      socket.send(encrypted);
    });
    this.sent = task.catch(() => {});
    return task;
  }

  private probe(): void {
    const socket = this.socket;
    const now = Date.now();
    if (document.visibilityState === "hidden" || now - this.tickAt > 40_000) this.pingAt = 0;
    this.tickAt = now;
    if (socket?.readyState !== WebSocket.OPEN || document.visibilityState === "hidden") return;
    if (this.pingAt && now - this.pingAt >= 30_000) socket.close();
    else if (!this.pingAt) { this.pingAt = now; socket.send("ping"); }
  }

  private connect(): void {
    if (this.signal.aborted) return;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const base: string = import.meta.env.VITE_PAIRING_URL || "wss://pair.yukireader.app";
    const url = new URL(`/v1/rooms/${this.credentials.room}`, base);
    url.searchParams.set("side", String(this.side));
    if (this.temporary) url.searchParams.set("temporary", "1");
    const socket = new WebSocket(url);
    this.socket = socket;
    this.ready = false;
    this.retry = setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, 10_000);
    socket.onopen = () => {
      if (socket !== this.socket) return;
      clearTimeout(this.retry);
      this.attempts = 0;
      this.pingAt = 0;
      this.tickAt = Date.now();
      this.heartbeat = setInterval(() => this.probe(), 15_000);
    };
    socket.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (socket !== this.socket || this.signal.aborted) return;
      if (message === "pong") { this.pingAt = 0; return; }
      if (typeof message !== "string" || message.length > 32_768) return;
      this.received = this.received.then(async () => {
        if (socket !== this.socket || this.signal.aborted) return;
        if (message === '{"type":"ready"}') { this.ready = true; this.onReady(); }
        else {
          const value = await decodeSignal(this.credentials.key, message);
          if (socket === this.socket && !this.signal.aborted) await this.onMessage(value);
        }
      }).catch(() => {}); // An invalid signal cannot invalidate a live data channel.
    };
    socket.onclose = () => {
      if (this.signal.aborted || socket !== this.socket) return;
      clearTimeout(this.retry);
      clearInterval(this.heartbeat);
      this.ready = false;
      const delay = Math.min(15_000, 800 * 2 ** Math.min(this.attempts++, 5));
      this.retry = setTimeout(() => this.connect(), delay + Math.random() * 300);
    };
    socket.onerror = () => socket.close();
  }
}

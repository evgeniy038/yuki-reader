import { ICE, opened } from "./p2p-connection";
import { PeerUnreachableError } from "./p2p-protocol";
import { decodeSignal, encodeSignal, signalingSecret } from "./peer-secret";

interface Options {
  secret: string;
  side: 0 | 1;
  temporary?: boolean;
  onControl(channel: RTCDataChannel): void;
  onChannel(channel: RTCDataChannel): void;
  onState(connected: boolean): void;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** One remembered peer, one live connection. Books use independent data
    channels on it: no cloud polling or ICE handshake per book. */
export class PeerLink {
  private pc?: RTCPeerConnection;
  private socket?: WebSocket;
  private session = "";
  private candidates: RTCIceCandidateInit[] = [];
  private stopped = false;
  private connected = false;
  private ready = false;
  private attempts = 0;
  private reconnect?: ReturnType<typeof setTimeout>;
  private negotiation?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastPong = 0;
  private received = Promise.resolve();
  private sent = Promise.resolve();
  private credentials?: Awaited<ReturnType<typeof signalingSecret>>;
  private abort = new AbortController();

  constructor(private readonly options: Options) {
    void signalingSecret(options.secret).then((credentials) => {
      if (this.stopped) return;
      this.credentials = credentials;
      if (!options.temporary && navigator.locks) {
        // Tabs share a device identity and pairing. Only one may own its
        // socket; otherwise they continually disconnect one another.
        void navigator.locks.request(`yuki-peer:${credentials.room}:${options.side}`, { signal: this.abort.signal }, async () => {
          if (this.stopped) return;
          this.connectSocket();
          await new Promise<void>((resolve) => this.abort.signal.addEventListener("abort", () => resolve(), { once: true }));
        }).catch(() => {});
      } else this.connectSocket();
    });
  }

  isConnected(): boolean { return this.connected; }

  async channel(label: string): Promise<RTCDataChannel> {
    const pc = this.pc;
    if (!pc || !this.connected) throw new PeerUnreachableError();
    const channel = pc.createDataChannel(label, { ordered: true });
    channel.binaryType = "arraybuffer";
    try { await opened(pc, channel, this.abort.signal); return channel; }
    catch (error) { channel.close(); throw error; }
  }

  frameSize(): number { return Math.min(256 * 1024, this.pc?.sctp?.maxMessageSize || 64 * 1024); }

  stop(): void {
    this.stopped = true;
    this.abort.abort(new PeerUnreachableError());
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.drop();
  }

  private drop(): void {
    clearTimeout(this.negotiation);
    const old = this.pc;
    this.pc = undefined;
    old?.close();
    if (this.connected) { this.connected = false; this.options.onState(false); }
  }

  private connectSocket(): void {
    if (this.stopped || !this.credentials) return;
    const base: string = import.meta.env.VITE_PAIRING_URL || "wss://pair.yukireader.app";
    const url = new URL(`/v1/rooms/${this.credentials.room}`, base);
    url.searchParams.set("side", String(this.options.side));
    if (this.options.temporary) url.searchParams.set("temporary", "1");
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.lastPong = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 55_000) socket.close();
        else if (socket.readyState === WebSocket.OPEN) socket.send("ping");
      }, 20_000);
    };
    socket.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (message === "pong") { this.lastPong = Date.now(); return; }
      if (typeof message !== "string" || message.length > 32_768) return;
      this.received = this.received.then(async () => {
        if (socket !== this.socket || this.stopped) return;
        if (message === '{"type":"ready"}') {
          this.ready = true;
          if (this.options.side === 0) await this.offer();
        } else if (this.credentials) {
          await this.signal(await decodeSignal(this.credentials.key, message));
        }
      }).catch(() => this.retryConnection());
    };
    socket.onclose = () => {
      clearInterval(this.heartbeat);
      this.ready = false;
      if (this.stopped || socket !== this.socket) return;
      const delay = Math.min(15_000, 800 * 2 ** Math.min(this.attempts++, 5));
      this.reconnect = setTimeout(() => this.connectSocket(), delay + Math.random() * 300);
    };
    socket.onerror = () => socket.close();
  }

  private send(value: unknown): Promise<void> {
    const socket = this.socket;
    const task = this.sent.then(async () => {
      if (!this.credentials || !socket || socket.readyState !== WebSocket.OPEN) throw new PeerUnreachableError();
      const encrypted = await encodeSignal(this.credentials.key, value);
      if (socket === this.socket && socket.readyState === WebSocket.OPEN) socket.send(encrypted);
    });
    this.sent = task.catch(() => {});
    return task;
  }

  private retryConnection(): void {
    if (this.stopped) return;
    this.drop();
    if (this.options.side === 0 && this.ready) {
      this.negotiation = setTimeout(() => { void this.offer().catch(() => this.retryConnection()); }, 2_000);
    }
  }

  private makeConnection(session: string): RTCPeerConnection {
    this.drop();
    this.session = session;
    this.candidates = [];
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    this.negotiation = setTimeout(() => { if (this.pc === pc) this.retryConnection(); }, 25_000);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.pc === pc) void this.send({ type: "ice", session, candidate: candidate.toJSON() }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.retryConnection();
      else if (pc.connectionState === "disconnected") {
        clearTimeout(this.negotiation);
        this.negotiation = setTimeout(() => { if (this.pc === pc) this.retryConnection(); }, 8_000);
      } else if (pc.connectionState === "connected") clearTimeout(this.negotiation);
    };
    pc.ondatachannel = ({ channel }) => {
      channel.binaryType = "arraybuffer";
      if (channel.label === "yuki-sync") this.control(channel, pc);
      else this.options.onChannel(channel);
    };
    return pc;
  }

  private control(channel: RTCDataChannel, pc: RTCPeerConnection): void {
    const ready = () => {
      if (this.pc !== pc || this.stopped) { channel.close(); return; }
      clearTimeout(this.negotiation);
      this.connected = true;
      this.options.onControl(channel);
      this.options.onState(true);
    };
    if (channel.readyState === "open") ready();
    else channel.addEventListener("open", ready, { once: true });
    channel.addEventListener("close", () => { if (this.pc === pc) this.retryConnection(); });
  }

  private async offer(): Promise<void> {
    if (this.stopped || !this.ready) return;
    const session = crypto.randomUUID();
    const pc = this.makeConnection(session);
    this.control(pc.createDataChannel("yuki-sync", { ordered: true }), pc);
    await pc.setLocalDescription(await pc.createOffer());
    if (this.pc === pc) await this.send({ type: "offer", session, sdp: pc.localDescription?.sdp });
  }

  private async signal(value: unknown): Promise<void> {
    if (!record(value) || typeof value.session !== "string") return;
    if (value.type === "offer" && this.options.side === 1 && typeof value.sdp === "string") {
      const pc = this.makeConnection(value.session);
      await pc.setRemoteDescription({ type: "offer", sdp: value.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (this.pc === pc) await this.send({ type: "answer", session: value.session, sdp: pc.localDescription?.sdp });
      return;
    }
    const pc = this.pc;
    if (!pc || value.session !== this.session) return;
    if (value.type === "answer" && this.options.side === 0 && typeof value.sdp === "string" && pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription({ type: "answer", sdp: value.sdp });
      for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
    } else if (value.type === "ice" && record(value.candidate)) {
      const raw = value.candidate;
      if (typeof raw.candidate !== "string") return;
      const candidate: RTCIceCandidateInit = {
        candidate: raw.candidate,
        sdpMid: typeof raw.sdpMid === "string" ? raw.sdpMid : null,
        sdpMLineIndex: typeof raw.sdpMLineIndex === "number" ? raw.sdpMLineIndex : null,
      };
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else this.candidates.push(candidate);
    }
  }
}

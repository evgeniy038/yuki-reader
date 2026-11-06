import { ICE, opened } from "./p2p-connection";
import { PeerUnreachableError } from "./p2p-protocol";
import { signalingSecret } from "./peer-secret";
import { PeerSignaling } from "./peer-signaling";

interface Options {
  secret: string;
  side: 0 | 1;
  temporary?: boolean;
  onControl(channel: RTCDataChannel): void;
  onChannel(channel: RTCDataChannel): void;
  onState(connected: boolean): void;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** One remembered peer, one transport. Signaling reconnection preserves it;
    network changes restart ICE on it; only a closed transport is replaced. */
export class PeerLink {
  private pc?: RTCPeerConnection;
  private controlChannel?: RTCDataChannel;
  private signaling?: PeerSignaling;
  private session = "";
  private candidates: RTCIceCandidateInit[] = [];
  private localCandidates: RTCIceCandidateInit[] = [];
  private descriptionSent = false;
  private connected = false;
  private negotiating = false;
  private negotiation?: ReturnType<typeof setTimeout>;
  private abort = new AbortController();

  constructor(private readonly options: Options) {
    void signalingSecret(options.secret).then((credentials) => {
      if (this.abort.signal.aborted) return;
      const start = () => {
        this.signaling = new PeerSignaling(credentials, options.side, options.temporary === true, this.abort.signal,
          () => {
            void this.send({ type: "hello", session: this.pc ? this.session : "", connected: this.connected }).catch(() => {});
            if (!this.pc && options.side === 0) void this.offer();
          },
          (value) => this.signal(value),
          () => { if (this.pc && ["failed", "disconnected", "closed"].includes(this.pc.connectionState)) this.recover(); });
      };
      if (!options.temporary && navigator.locks) {
        // A shared device identity has one owner, including across tabs.
        void navigator.locks.request(`yuki-peer:${credentials.room}:${options.side}`, { signal: this.abort.signal }, async () => {
          if (this.abort.signal.aborted) return;
          start();
          await new Promise<void>((resolve) => this.abort.signal.addEventListener("abort", () => resolve(), { once: true }));
        }).catch(() => {});
      } else start();
    }).catch(() => {});
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
    this.abort.abort(new PeerUnreachableError());
    this.drop();
  }

  private state(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.options.onState(connected);
  }

  private drop(): void {
    clearTimeout(this.negotiation);
    const old = this.pc;
    this.pc = undefined;
    this.controlChannel = undefined;
    this.negotiating = false;
    old?.close();
    this.state(false);
  }

  private send(value: unknown): Promise<void> {
    return this.signaling?.send(value) ?? Promise.reject(new PeerUnreachableError());
  }

  private deadline(pc: RTCPeerConnection, ms = 25_000, rebuild = true): void {
    clearTimeout(this.negotiation);
    this.negotiation = setTimeout(() => {
      if (this.pc === pc && (!this.connected || pc.signalingState !== "stable")) this.recover(rebuild);
    }, ms);
  }

  private recover(rebuild = false): void {
    if (this.abort.signal.aborted) return;
    const session = this.session;
    rebuild ||= !this.pc || this.pc.connectionState === "closed" || this.controlChannel?.readyState === "closed";
    if (rebuild) this.drop();
    if (!this.signaling?.ready) return;
    if (this.options.side === 0) void this.offer();
    else {
      void this.send({ type: "restart", session, rebuild }).catch(() => {});
      clearTimeout(this.negotiation);
      this.negotiation = setTimeout(() => this.recover(true), 25_000);
    }
  }

  private makeConnection(session: string): RTCPeerConnection {
    this.drop();
    this.session = session;
    this.candidates = [];
    this.localCandidates = [];
    this.descriptionSent = false;
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    this.deadline(pc);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.pc !== pc) return;
      if (!this.descriptionSent) this.localCandidates.push(candidate.toJSON());
      else void this.send({ type: "ice", session, candidate: candidate.toJSON() }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") { this.state(false); this.recover(); }
      else if (pc.connectionState === "disconnected") { this.state(false); this.deadline(pc, 8_000, false); }
      else if (pc.connectionState === "connected") {
        if (this.controlChannel?.readyState === "open") clearTimeout(this.negotiation);
        this.state(this.controlChannel?.readyState === "open");
      }
    };
    pc.ondatachannel = ({ channel }) => {
      if (this.pc !== pc) { channel.close(); return; }
      channel.binaryType = "arraybuffer";
      if (channel.label === "yuki-sync") this.control(channel, pc);
      else this.options.onChannel(channel);
    };
    return pc;
  }

  private control(channel: RTCDataChannel, pc: RTCPeerConnection): void {
    this.controlChannel = channel;
    const ready = () => {
      if (this.pc !== pc || this.abort.signal.aborted) { channel.close(); return; }
      clearTimeout(this.negotiation);
      this.options.onControl(channel);
      this.state(true);
    };
    if (channel.readyState === "open") ready();
    else channel.addEventListener("open", ready, { once: true });
    channel.addEventListener("close", () => { if (this.pc === pc) this.recover(true); });
  }

  private async describe(pc: RTCPeerConnection, type: "offer" | "answer"): Promise<void> {
    if (this.pc !== pc) return;
    await this.send({ type, session: this.session, sdp: pc.localDescription?.sdp });
    if (this.pc !== pc) return;
    this.descriptionSent = true;
    for (const candidate of this.localCandidates.splice(0)) await this.send({ type: "ice", session: this.session, candidate });
  }

  private async offer(): Promise<void> {
    if (this.abort.signal.aborted || !this.signaling?.ready || this.negotiating || this.pc?.signalingState === "have-local-offer") return;
    const restart = !!this.pc;
    const pc = this.pc ?? this.makeConnection(crypto.randomUUID());
    if (!restart) this.control(pc.createDataChannel("yuki-sync", { ordered: true }), pc);
    this.negotiating = true;
    this.descriptionSent = false;
    this.deadline(pc);
    try {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: restart }));
      await this.describe(pc, "offer");
    } catch {
      if (this.pc === pc && !this.connected) this.deadline(pc, 2_000);
    } finally { if (this.pc === pc) this.negotiating = false; }
  }

  private async candidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    // Late candidates from a previous ICE generation are normal on resume.
    try { if (this.pc === pc) await pc.addIceCandidate(candidate); } catch { /* Keep the negotiated transport. */ }
  }

  private async signal(value: unknown): Promise<void> {
    if (this.abort.signal.aborted || !record(value) || typeof value.session !== "string") return;
    if (value.type === "hello" && this.options.side === 0) {
      if (!this.connected && this.pc && (this.negotiating || this.pc.signalingState !== "stable")) return;
      if (!this.pc || value.session !== this.session) { this.drop(); await this.offer(); }
      else if (!this.connected && this.pc.signalingState === "stable") await this.offer();
      return;
    }
    if (value.type === "restart" && this.options.side === 0 && value.session === this.session) {
      if (value.rebuild === true) this.drop();
      await this.offer();
      return;
    }
    if (value.type === "offer" && this.options.side === 1 && typeof value.sdp === "string") {
      const pc = this.pc && value.session === this.session ? this.pc : this.makeConnection(value.session);
      this.descriptionSent = false;
      this.deadline(pc);
      await pc.setRemoteDescription({ type: "offer", sdp: value.sdp });
      if (this.pc !== pc) return;
      await pc.setLocalDescription(await pc.createAnswer());
      await this.describe(pc, "answer");
      return;
    }
    const pc = this.pc;
    if (!pc || value.session !== this.session) return;
    if (value.type === "answer" && this.options.side === 0 && typeof value.sdp === "string" && pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription({ type: "answer", sdp: value.sdp });
      if (this.pc !== pc) return;
      for (const candidate of this.candidates.splice(0)) await this.candidate(pc, candidate);
    } else if (value.type === "ice" && record(value.candidate)) {
      const raw = value.candidate;
      if (typeof raw.candidate !== "string") return;
      const candidate: RTCIceCandidateInit = {
        candidate: raw.candidate,
        sdpMid: typeof raw.sdpMid === "string" ? raw.sdpMid : null,
        sdpMLineIndex: typeof raw.sdpMLineIndex === "number" ? raw.sdpMLineIndex : null,
        usernameFragment: typeof raw.usernameFragment === "string" ? raw.usernameFragment : undefined,
      };
      if (pc.remoteDescription) await this.candidate(pc, candidate);
      else if (this.candidates.length < 64) this.candidates.push(candidate);
    }
  }
}

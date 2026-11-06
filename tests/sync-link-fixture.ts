import { PeerLink } from "../src/components/sync/peer-link";
import { peerMessages } from "../src/components/sync/peer-messages";
import { decodeSignal, encodeSignal, signalingSecret } from "../src/components/sync/peer-secret";

const sockets: WebSocket[] = [];
const connections: RTCPeerConnection[] = [];
let link: PeerLink;
let messages: ReturnType<typeof peerMessages>;
let key: CryptoKey;
let session = "";
let opened = 0;
let bytes = 0;
const states: string[] = [];

export async function prepare(secret: string, side: 0 | 1): Promise<void> {
  key = (await signalingSecret(secret)).key;
  const Socket = WebSocket;
  window.WebSocket = class extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols); sockets.push(this);
      this.addEventListener("open", () => opened++);
      this.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string" || !event.data.includes(".")) return;
        void decodeSignal(key, event.data).then((value) => {
          if (typeof value === "object" && value !== null && "session" in value && typeof value.session === "string") session = value.session;
        }).catch(() => {});
      });
    }
  };
  const Connection = RTCPeerConnection;
  window.RTCPeerConnection = class extends Connection {
    constructor(config?: RTCConfiguration) { super(config); connections.push(this); }
  };
  link = new PeerLink({ secret, side, onChannel: (channel) => channel.close(),
    onState: (state) => states.push(String(state)),
    onControl: (channel) => {
      messages?.dispose();
      messages = peerMessages(channel, (packet) => {
        if (typeof packet !== "string") throw new Error("Unexpected packet");
        bytes += packet.length;
      });
    },
  });
}
export const state = () => ({ connected: link.isConnected(), pcs: connections.length, opened, bytes, states,
  ufrag: connections.at(-1)?.localDescription?.sdp.match(/a=ice-ufrag:(\S+)/)?.[1] });
export const send = (count: number) => messages.send("x".repeat(count));
export function loseSignaling(): void { sockets.at(-1)?.close(); }
export function resumeAfterSleep(): void {
  const now = Date.now;
  Date.now = () => now() + 120_000;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
}
export async function restartTransport(): Promise<void> {
  sockets.at(-1)?.send(await encodeSignal(key, { type: "restart", session, rebuild: false }));
}
export async function staleCandidate(): Promise<void> {
  if (!session) throw new Error("No negotiated session");
  const data = await encodeSignal(key, { type: "ice", session, candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 12345 typ host", sdpMid: "missing-media", sdpMLineIndex: 123, usernameFragment: "stale" } });
  sockets.at(-1)?.dispatchEvent(new MessageEvent("message", { data }));
}

import { randomBytes, toBase64Url } from "@/core/sync/crypto";
import { parseDeviceInfo, type DeviceInfo } from "@/core/sync/model";
import type { PairedDevice } from "@/core/sync/peer-store";
import { PeerLink } from "./peer-link";
import { peerMessages } from "./peer-messages";
import { newPairCode, normalizePairCode, validPairCode } from "./peer-secret";

export interface PairingView {
  phase: "idle" | "waiting" | "joining" | "confirm" | "error";
  code?: string;
  candidate?: DeviceInfo;
  error?: "code" | "expired" | "connection";
}

/** Pairing never exposes a catalog. The first device approves the second
    before they exchange a fresh 256-bit secret for future connections. */
export function pairing(
  me: () => Promise<DeviceInfo>,
  changed: (view: PairingView) => void,
  remember: (peer: PairedDevice) => Promise<void>,
) {
  let link: PeerLink | undefined;
  let messages: ReturnType<typeof peerMessages> | undefined;
  let candidate: DeviceInfo | undefined;
  let side: 0 | 1 = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let approved = false;
  const stop = () => {
    generation++;
    clearTimeout(timer);
    messages?.dispose();
    messages = undefined;
    link?.stop();
    link = undefined;
    candidate = undefined;
    approved = false;
  };
  const cancel = () => { stop(); changed({ phase: "idle" }); };

  const start = async (code: string, role: 0 | 1) => {
    stop();
    side = role;
    const attempt = generation;
    changed({ phase: role === 0 ? "waiting" : "joining", code: role === 0 ? code : undefined });
    const self = await me();
    if (attempt !== generation) return;
    timer = setTimeout(() => { stop(); changed({ phase: "error", error: role === 0 ? "expired" : "connection" }); }, role === 0 ? 300_000 : 60_000);
    link = new PeerLink({
      secret: code, side: role, temporary: true,
      onState: () => {},
      onChannel: (channel) => channel.close(),
      onControl: (channel) => {
        messages?.dispose();
        messages = peerMessages(channel, async (value) => {
          if (attempt !== generation || typeof value !== "object" || value === null || !("type" in value)) return;
          if (value.type === "hello" && "device" in value) {
            const peer = parseDeviceInfo(value.device);
            if (!peer || peer.id === self.id) { cancel(); return; }
            candidate = peer;
            if (role === 0) changed({ phase: "confirm", code, candidate: peer });
          } else if (value.type === "pair" && role === 1 && candidate && "secret" in value && typeof value.secret === "string" && /^[\w-]{43}$/.test(value.secret)) {
            await remember({ device: candidate, secret: value.secret, side: 1 });
            await messages?.send({ type: "accepted" });
            // Let the ordered acknowledgement reach the first device.
            clearTimeout(timer);
            timer = setTimeout(cancel, 1_000);
          } else if (value.type === "accepted" && role === 0 && approved) cancel();
        });
        void messages.send({ type: "hello", device: self }).catch(() => channel.close());
      },
    });
  };

  return {
    create: () => start(newPairCode(), 0),
    join: async (text: string) => {
      const code = normalizePairCode(text);
      if (!validPairCode(code)) { changed({ phase: "error", error: "code" }); return; }
      await start(code, 1);
    },
    confirm: async () => {
      if (side !== 0 || !candidate || !messages || approved) return;
      approved = true;
      const secret = toBase64Url(randomBytes(32));
      await remember({ device: candidate, secret, side: 0 });
      await messages.send({ type: "pair", secret });
    },
    cancel,
  };
}

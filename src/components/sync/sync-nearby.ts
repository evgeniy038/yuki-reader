import type { BookRecord } from "@/core/storage";
import type { DeviceInfo } from "@/core/sync/model";
import type { PersonalState } from "@/core/sync/pack-stream";
import { applyPeerUpdate, parsePeerSnapshot, type PeerExchange, type PeerSnapshot } from "@/core/sync/peer-snapshot";
import { forgetPairedDevice, pairedDevices, savePairedDevice, type PairedDevice } from "@/core/sync/peer-store";
import { syncStore } from "@/core/sync/store";
import { packSourceOf } from "./sync-bridge";
import { currentHost, device, onRoundDone, requestSync } from "./sync-controller";
import { setSyncEnabled } from "./sync-signal";
import { PeerLink } from "./peer-link";
import { peerMessages } from "./peer-messages";
import { pairing, type PairingView } from "./peer-pairing";
import { parseMessage, PeerUnreachableError, receiveBook, sendBook } from "./p2p-wire";
import { pause } from "./p2p-connection";
import type { DirectStage } from "./p2p";
import { servePeerOcr, syncPeerOcr } from "./peer-ocr";

interface NearbyView {
  pairing: PairingView;
  devices: { info: DeviceInfo; connected: boolean }[];
}
interface Connection {
  paired: PairedDevice;
  link: PeerLink;
  messages?: ReturnType<typeof peerMessages>;
  snapshot?: PeerSnapshot;
}

let view: NearbyView = { pairing: { phase: "idle" }, devices: [] };
const listeners = new Set<() => void>();
const connections = new Map<string, Connection>();
let initialized: Promise<void> | undefined;
let own: PeerSnapshot | undefined;
let ownParts = { state: "", stats: "", catalog: "" };

const update = (patch: Partial<NearbyView>) => {
  view = { ...view, ...patch };
  for (const listener of listeners) listener();
};
const devicesChanged = () => update({ devices: [...connections.values()].map(({ paired, link }) => ({ info: paired.device, connected: link.isConnected() })) });
export const getNearbyView = (): NearbyView => view;
export const subscribeNearby = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export const nearbyEnabled = (): boolean => connections.size > 0;
export const nearbyMode = (): "creator" | "joiner" => [...connections.values()].some((entry) => entry.paired.side === 1) ? "joiner" : "creator";

export const nearbyExchange: PeerExchange = {
  snapshots: () => [...connections.values()].flatMap((entry) => entry.link.isConnected() && entry.snapshot ? [entry.snapshot] : []),
  publish: async (snapshot) => {
    const next = { state: JSON.stringify(snapshot.state), stats: JSON.stringify(snapshot.stats), catalog: JSON.stringify(snapshot.catalog) };
    const changes = {
      ...(next.state !== ownParts.state ? { state: snapshot.state } : {}),
      ...(next.stats !== ownParts.stats ? { stats: snapshot.stats } : {}),
      ...(next.catalog !== ownParts.catalog ? { catalog: snapshot.catalog } : {}),
    };
    if (Object.keys(changes).length === 0) return;
    const message = own ? { type: "update", ...changes } : { type: "snapshot", snapshot };
    own = snapshot;
    ownParts = next;
    await Promise.all([...connections.values()].map(async (entry) => {
      if (entry.link.isConnected()) await entry.messages?.send(message).catch(() => {});
    }));
  },
};

async function source(key: string) {
  const host = currentHost();
  const keys = await syncStore.bookKeys();
  const id = [...keys].find(([localId, k]) => k === key && host?.books().some((book) => book.id === localId))?.[0];
  return host && id ? packSourceOf(host, id) : null;
}

function serve(channel: RTCDataChannel, link: PeerLink): void {
  if (channel.label.startsWith("yuki-ocr:")) {
    servePeerOcr(channel, () => source(channel.label.slice("yuki-ocr:".length)));
    return;
  }
  if (!channel.label.startsWith("yuki-book:")) { channel.close(); return; }
  let requested = false;
  const timer = setTimeout(() => channel.close(), 30_000);
  channel.addEventListener("close", () => clearTimeout(timer));
  channel.addEventListener("message", (event: MessageEvent) => {
    const request = typeof event.data === "string" ? parseMessage(event.data) : null;
    if (request?.t !== "get" || requested) return;
    requested = true;
    clearTimeout(timer);
    void source(request.key).then((pack) => sendBook(channel, pack, request.window, { frame: link.frameSize(), framed: request.framed }))
      .catch(() => channel.close());
  });
}

function connectPeer(paired: PairedDevice): void {
  const previous = connections.get(paired.device.id);
  previous?.messages?.dispose();
  previous?.link.stop();
  const link = new PeerLink({
    secret: paired.secret, side: paired.side,
    onState: () => {
      const entry = connections.get(paired.device.id);
      if (entry?.link !== link) return;
      if (link.isConnected()) pair.connected(paired.device.id);
      devicesChanged();
      requestSync(100);
    },
    onChannel: (channel) => serve(channel, link),
    onControl: (channel) => {
      const entry = connections.get(paired.device.id);
      if (!entry || entry.link !== link) { channel.close(); return; }
      entry.messages?.dispose();
      entry.messages = peerMessages(channel, (value) => {
        if (typeof value !== "object" || value === null || !("type" in value)) return;
        if (value.type === "forget") { void forgetNearby(paired.device.id, false); return; }
        const snapshot = value.type === "snapshot" && "snapshot" in value ? parsePeerSnapshot(value.snapshot)
          : value.type === "update" ? applyPeerUpdate(entry.snapshot, value) : undefined;
        if (!snapshot || snapshot.state.device.id !== paired.device.id) { channel.close(); return; }
        entry.snapshot = snapshot;
        requestSync(100);
      });
      if (own) void entry.messages.send({ type: "snapshot", snapshot: own }).catch(() => channel.close());
      requestSync(0);
    },
  });
  connections.set(paired.device.id, { paired, link });
  devicesChanged();
}

async function remember(paired: PairedDevice): Promise<void> {
  await savePairedDevice(paired);
  setSyncEnabled(true);
  connectPeer(paired);
  requestSync(0);
}

const pair = pairing(device, (pairing) => update({ pairing }), remember);

export function initNearby(): Promise<void> {
  initialized ??= pairedDevices().then((peers) => {
    for (const peer of peers) connectPeer(peer);
    onRoundDone(async () => {
      const host = currentHost();
      if (host) await syncPeerOcr(host, (key) => holder(key)?.link);
    });
  });
  return initialized;
}

export async function createPairCode(): Promise<void> {
  setSyncEnabled(true);
  await initNearby();
  await pair.create();
}
export async function joinPairCode(code: string): Promise<void> {
  setSyncEnabled(true);
  await initNearby();
  await pair.join(code);
}
export const confirmPair = (): Promise<void> => pair.confirm();
export const cancelPair = (): void => pair.cancel();

export async function forgetNearby(id: string, notify = true): Promise<void> {
  const entry = connections.get(id);
  if (!entry) return;
  connections.delete(id);
  if (notify) await entry.messages?.send({ type: "forget" }).catch(() => {});
  entry.messages?.dispose();
  entry.link.stop();
  await forgetPairedDevice(id);
  devicesChanged();
}

const holder = (key: string): Connection | undefined => [...connections.values()].find(({ link, snapshot }) => link.isConnected() && snapshot?.catalog.books[key] && snapshot.catalog.books[key]?.prep === undefined);
export const nearbyHas = (key: string): boolean => holder(key) !== undefined;
export const nearbyKnows = (id: string): boolean => connections.has(id);

export async function downloadNearby(opts: {
  key: string; id: string; personal: PersonalState;
  onStage: (stage: DirectStage) => void;
  onProgress: (done: number, total: number) => void;
}): Promise<BookRecord> {
  for (let attempt = 0; ; attempt++) {
    let channel: RTCDataChannel | undefined;
    try {
      opts.onStage("connecting");
      const deadline = Date.now() + 25_000;
      let entry: Connection | undefined;
      do {
        entry = holder(opts.key);
        if (entry) break;
        await pause(250, AbortSignal.timeout(300));
      } while (Date.now() < deadline);
      if (!entry) throw new PeerUnreachableError();
      channel = await entry.link.channel(`yuki-book:${crypto.randomUUID()}`);
      return await receiveBook(channel, opts);
    } catch (error) {
      if (!(error instanceof PeerUnreachableError) || attempt >= 2) throw error;
      opts.onProgress(0, 1);
    } finally { channel?.close(); }
  }
}

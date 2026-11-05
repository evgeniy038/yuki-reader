import { openDB, type DBSchema } from "idb";
import { parseDeviceInfo, type DeviceInfo } from "./model";

export interface PairedDevice {
  device: DeviceInfo;
  secret: string;
  side: 0 | 1;
}

interface PeerDB extends DBSchema { peers: { key: string; value: unknown } }
const db = () => openDB<PeerDB>("yuki-peers", 1, {
  upgrade(database) { database.createObjectStore("peers"); },
});

export async function pairedDevices(): Promise<PairedDevice[]> {
  const database = await db();
  try {
    const result: PairedDevice[] = [];
    for (const value of await database.getAll("peers")) {
      if (typeof value !== "object" || value === null || !("device" in value) || !("secret" in value) || !("side" in value)) continue;
      const device = parseDeviceInfo(value.device);
      if (device && typeof value.secret === "string" && /^[\w-]{43}$/.test(value.secret) && (value.side === 0 || value.side === 1)) {
        result.push({ device, secret: value.secret, side: value.side });
      }
    }
    return result;
  } finally { database.close(); }
}

export async function savePairedDevice(peer: PairedDevice): Promise<void> {
  const database = await db();
  try { await database.put("peers", peer, peer.device.id); }
  finally { database.close(); }
}

export async function forgetPairedDevice(id: string): Promise<void> {
  const database = await db();
  try { await database.delete("peers", id); }
  finally { database.close(); }
}

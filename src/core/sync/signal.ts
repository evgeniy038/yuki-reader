import { sealJson, unsealJson } from "./crypto";
import type { RemoteFolder } from "./remote";
import type { VaultBinding } from "./store";

// The cloud as a doorbell for a direct device-to-device transfer: the
// asking device leaves a sealed WebRTC offer, the holding device a sealed
// answer. Sealed with the library key, so only the person's own devices can
// read them — and the DTLS fingerprints inside are what the data channel
// then authenticates against: nobody, the cloud included, can step in
// between. Each device writes only its own folder:
//   signal/<from>/<to>.offer.bin    from wants something from to
//   signal/<from>/<to>.answer.bin   from answers to's offer

export interface Signal {
  v: 1;
  /** Pairs an answer with the offer it answers. */
  session: string;
  sdp: string;
  at: number;
}

/** Signals older than this are left alone (a stale doorbell). */
export const SIGNAL_TTL_MS = 2 * 60_000;

export const offerPath = (from: string, to: string): string => `signal/${from}/${to}.offer.bin`;
export const answerPath = (from: string, to: string): string => `signal/${from}/${to}.answer.bin`;
export const OFFER = /^signal\/([^/]+)\/([^/]+)\.offer\.bin$/;

export async function writeSignal(
  remote: RemoteFolder,
  vault: VaultBinding,
  path: string,
  signal: Signal,
): Promise<void> {
  await remote.write(path, await sealJson(vault.keys, vault.id, path, signal));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseSignal(value: unknown, now = Date.now()): Signal | null {
  if (!isObject(value)) return null;
  const v = value;
  if (v.v !== 1 || typeof v.session !== "string" || typeof v.sdp !== "string" || typeof v.at !== "number") return null;
  if (now - v.at > SIGNAL_TTL_MS) return null;
  return { v: 1, session: v.session, sdp: v.sdp, at: v.at };
}

/** The signal at `path`, or null (absent, stale, not ours, damaged). */
export async function readSignal(
  remote: RemoteFolder,
  vault: VaultBinding,
  path: string,
): Promise<Signal | null> {
  const sealed = await remote.read(path).catch(() => null);
  if (!sealed) return null;
  return unsealJson(vault.keys, vault.id, path, sealed).then((v) => parseSignal(v), () => null);
}

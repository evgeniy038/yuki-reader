import type { BookKey } from "@/core/sync/model";
import { parsePackManifest, type PackManifest } from "@/core/sync/pack-shape";

export const FRAME = 64 * 1024;
export const WINDOW = 16 * 1024 * 1024;
export const ACK_EVERY = 1024 * 1024;
export const MAX_METADATA = 16 * 1024 * 1024;
export const STALL_MS = 30_000;

export class PeerUnavailableError extends Error {
  constructor() {
    super("The other device didn't answer");
    this.name = "PeerUnavailableError";
  }
}

export class PeerUnreachableError extends Error {
  constructor() {
    super("The direct connection was interrupted or couldn't be opened");
    this.name = "PeerUnreachableError";
  }
}

export type Message =
  | { t: "get"; key: BookKey; window?: number; framed?: boolean }
  | { t: "ack"; stored: number }
  | { t: "manifest"; manifest: PackManifest }
  | { t: "metadata"; size: number }
  | { t: "end" }
  | { t: "error"; reason: string };

const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function parseMessage(text: string): Message | null {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return null; }
  if (typeof value !== "object" || value === null || !("t" in value)) return null;
  if (value.t === "get" && "key" in value && typeof value.key === "string") {
    if ("window" in value && (!positive(value.window) || value.window < ACK_EVERY)) return null;
    return {
      t: "get", key: value.key,
      ...("window" in value && positive(value.window) ? { window: Math.min(value.window, WINDOW) } : {}),
      ...("framed" in value && value.framed === true ? { framed: true } : {}),
    };
  }
  if (value.t === "ack" && "stored" in value && (value.stored === 0 || positive(value.stored))) {
    return { t: "ack", stored: value.stored };
  }
  if (value.t === "manifest" && "manifest" in value) {
    const manifest = parsePackManifest(value.manifest);
    return manifest ? { t: "manifest", manifest } : null;
  }
  if (value.t === "metadata" && "size" in value && positive(value.size) && value.size <= MAX_METADATA) {
    return { t: "metadata", size: value.size };
  }
  if (value.t === "end") return { t: "end" };
  if (value.t === "error") return { t: "error", reason: "reason" in value && typeof value.reason === "string" ? value.reason : "" };
  return null;
}

import { fromBase64Url, randomBytes, toBase64Url } from "@/core/sync/crypto";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encoder = new TextEncoder();

export const newPairCode = (): string => Array.from(randomBytes(10), (b) => alphabet[b & 31]).join("");
export const normalizePairCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
export const validPairCode = (code: string): boolean => /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code);

/** The server sees a room digest, never the code or the encryption key. */
export async function signalingSecret(secret: string): Promise<{ room: string; key: CryptoKey }> {
  const digest = async (purpose: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`yuki-pair/1/${purpose}/${secret}`)));
  const room = Array.from(await digest("room"), (b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", (await digest("key")).slice().buffer, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { room, key };
}

export async function encodeSignal(key: CryptoKey, value: unknown): Promise<string> {
  const nonce = randomBytes(12);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce.slice().buffer }, key, encoder.encode(JSON.stringify(value)));
  return `${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(cipher))}`;
}

export async function decodeSignal(key: CryptoKey, message: string): Promise<unknown> {
  const [iv, data] = message.split(".");
  if (!iv || !data) throw new Error("Invalid signaling packet");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv).slice().buffer }, key, fromBase64Url(data).slice().buffer);
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

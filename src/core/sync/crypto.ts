import { deflateSync, inflateSync } from "fflate";

// End-to-end encryption for everything that leaves the device — WebCrypto
// only, no dependency. One random 256-bit vault key (DK) per library; HKDF
// turns it into an AES-256-GCM key for content and an HMAC key for
// fingerprints. The raw DK exists only while a vault is created or unlocked;
// after that the device keeps non-extractable CryptoKeys.
//
// Sealed file: "YK1" | version 1 | nonce(12) | AES-GCM(deflate(payload)).
// The AAD binds each file to its vault and its path, so the cloud can't
// swap one device's state for another's or replay a file from another
// vault (the CCS 2024 finding against 4 of 5 "E2EE" cloud storages).
// Random 96-bit nonces are safe far beyond this app's scale (NIST: 2^32
// messages per key).

const MAGIC = [0x59, 0x4b, 0x31]; // "YK1"
const VERSION = 1;
const NONCE_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface VaultKeys {
  enc: CryptoKey;
  name: CryptoKey;
  /** Short public fingerprint of DK: an unlocked device pins it and refuses
      a slot that unwraps to a different key (forced-key attack). */
  fingerprint: string;
}

export class SealError extends Error {
  constructor(message = "A sync file could not be opened") {
    super(message);
    this.name = "SealError";
  }
}

const buf = (bytes: Uint8Array): BufferSource => bytes as BufferSource;

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export async function deriveVaultKeys(dk: Uint8Array): Promise<VaultKeys> {
  const base = await crypto.subtle.importKey("raw", buf(dk), "HKDF", false, ["deriveKey"]);
  const params = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: buf(encoder.encode("yuki-sync/1")),
    info: buf(encoder.encode(info)),
  });
  const enc = await crypto.subtle.deriveKey(
    params("enc"),
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const name = await crypto.subtle.deriveKey(
    params("name"),
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", name, buf(encoder.encode("fingerprint"))),
  );
  return { enc, name, fingerprint: hex(mac.slice(0, 16)) };
}

/** A book's folder name in the cloud: an HMAC of its content key, never the
    key itself — the provider can't test "does this user have file X" by
    hashing a known file. */
export async function folderName(keys: VaultKeys, bookKey: string): Promise<string> {
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", keys.name, buf(encoder.encode(`book:${bookKey}`))),
  );
  return hex(mac.slice(0, 16));
}

const aadFor = (vaultId: string, path: string): Uint8Array =>
  encoder.encode(`yuki/1/${vaultId}/${path}`);

export async function seal(
  keys: VaultKeys,
  vaultId: string,
  path: string,
  payload: Uint8Array,
  /** false for bytes that are already compressed (scans, PDFs): deflate
      then only stores (level 0) — same format, none of the CPU. */
  compress = true,
): Promise<Uint8Array> {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(nonce), additionalData: buf(aadFor(vaultId, path)) },
      keys.enc,
      buf(deflateSync(payload, { level: compress ? 6 : 0 })),
    ),
  );
  const out = new Uint8Array(MAGIC.length + 1 + NONCE_BYTES + cipher.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(nonce, MAGIC.length + 1);
  out.set(cipher, MAGIC.length + 1 + NONCE_BYTES);
  return out;
}

export async function unseal(
  keys: VaultKeys,
  vaultId: string,
  path: string,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  const header = MAGIC.length + 1 + NONCE_BYTES;
  if (sealed.length < header + 16 || MAGIC.some((byte, i) => sealed[i] !== byte)) {
    throw new SealError("Not a yuki sync file");
  }
  if (sealed[MAGIC.length] !== VERSION) throw new SealError("Unsupported sync file version");
  const nonce = sealed.slice(MAGIC.length + 1, header);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf(nonce), additionalData: buf(aadFor(vaultId, path)) },
        keys.enc,
        buf(sealed.slice(header)),
      ),
    );
  } catch {
    throw new SealError();
  }
  try {
    return inflateSync(plain);
  } catch {
    throw new SealError("A sync file is damaged");
  }
}

export async function sealJson(
  keys: VaultKeys,
  vaultId: string,
  path: string,
  value: unknown,
): Promise<Uint8Array> {
  return seal(keys, vaultId, path, encoder.encode(JSON.stringify(value)));
}

/** Decrypt + JSON.parse; the result is still unknown — callers narrow it. */
export async function unsealJson(
  keys: VaultKeys,
  vaultId: string,
  path: string,
  sealed: Uint8Array,
): Promise<unknown> {
  const text = decoder.decode(await unseal(keys, vaultId, path, sealed));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SealError("A sync file is damaged");
  }
}

// ---------------------------------------------------------------------------
// Recovery key: 128 random bits as Crockford base32 (26 symbols, the last two
// bits zero) plus Crockford's mod-37 check symbol, shown in groups of four.
// High entropy, so no slow KDF is needed — HKDF is enough; offline guessing
// a 2^128 space is hopeless even for the cloud provider holding the slot.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_ALPHABET = `${ALPHABET}*~$=U`;
const RECOVERY_BYTES = 16;
const DATA_SYMBOLS = 26;

function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

export function formatRecoveryKey(bytes: Uint8Array): string {
  const value = bytesToBigInt(bytes);
  const shifted = value << 2n; // 128 → 130 bits = 26 symbols
  let symbols = "";
  for (let i = DATA_SYMBOLS - 1; i >= 0; i -= 1) {
    symbols += ALPHABET[Number((shifted >> BigInt(i * 5)) & 31n)];
  }
  symbols += CHECK_ALPHABET[Number(value % 37n)];
  return symbols.match(/.{1,4}/g)!.join("-");
}

/** The 16 key bytes, or null when the text is not a valid recovery key
    (typos are caught by the check symbol). */
export function parseRecoveryKey(text: string): Uint8Array | null {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (clean.length !== DATA_SYMBOLS + 1) return null;
  let shifted = 0n;
  for (const symbol of clean.slice(0, DATA_SYMBOLS)) {
    const digit = ALPHABET.indexOf(symbol);
    if (digit === -1) return null;
    shifted = (shifted << 5n) | BigInt(digit);
  }
  if ((shifted & 3n) !== 0n) return null;
  const value = shifted >> 2n;
  if (CHECK_ALPHABET[Number(value % 37n)] !== clean[DATA_SYMBOLS]) return null;
  const bytes = new Uint8Array(RECOVERY_BYTES);
  for (let i = RECOVERY_BYTES - 1, rest = value; i >= 0; i -= 1, rest >>= 8n) {
    bytes[i] = Number(rest & 0xffn);
  }
  return bytes;
}

export function newRecoveryKeyBytes(): Uint8Array {
  return randomBytes(RECOVERY_BYTES);
}

async function recoveryKek(recovery: Uint8Array, vaultId: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(recovery), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(encoder.encode("yuki-sync/1/recovery")),
      info: buf(encoder.encode(vaultId)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const slotAad = (vaultId: string): BufferSource =>
  buf(encoder.encode(`yuki/1/${vaultId}/keys/recovery`));

export async function wrapWithRecovery(
  dk: Uint8Array,
  recovery: Uint8Array,
  vaultId: string,
): Promise<{ nonce: string; wrapped: string }> {
  const nonce = randomBytes(NONCE_BYTES);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(nonce), additionalData: slotAad(vaultId) },
    await recoveryKek(recovery, vaultId),
    buf(dk),
  );
  return { nonce: toBase64Url(nonce), wrapped: toBase64Url(new Uint8Array(wrapped)) };
}

/** The raw DK, or null when the recovery key doesn't open this slot. */
export async function unwrapWithRecovery(
  slot: { nonce: string; wrapped: string },
  recovery: Uint8Array,
  vaultId: string,
): Promise<Uint8Array | null> {
  try {
    const dk = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(fromBase64Url(slot.nonce)), additionalData: slotAad(vaultId) },
      await recoveryKek(recovery, vaultId),
      buf(fromBase64Url(slot.wrapped)),
    );
    return new Uint8Array(dk);
  } catch {
    return null;
  }
}

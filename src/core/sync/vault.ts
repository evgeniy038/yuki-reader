import {
  deriveVaultKeys,
  formatRecoveryKey,
  newRecoveryKeyBytes,
  parseRecoveryKey,
  randomBytes,
  unwrapWithRecovery,
  wrapWithRecovery,
} from "./crypto";
import { parseKeySlot, parseVaultFile, type KeySlot, type VaultFile } from "./model";
import type { RemoteFolder } from "./remote";
import type { VaultBinding } from "./store";

// The vault: the library key lives in the cloud only WRAPPED — by the
// recovery key (mandatory: sync doesn't start until the user has it, the
// way Apple won't enable Advanced Data Protection without a way back). The
// first device creates it; every other device unlocks it. A folder that has
// device files but no vault is reported, never silently replaced: a new
// vault there would orphan the other devices (and is what a hostile cloud
// would try in order to force a key of its choosing).

export const VAULT_PATH = "vault.json";
export const RECOVERY_SLOT_PATH = "keys/recovery.json";

export type VaultErrorCode = "exists" | "missing" | "damaged" | "typo" | "wrong" | "changed";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode) {
    super(`Sync vault: ${code}`);
    this.name = "VaultError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readJson(remote: RemoteFolder, path: string): Promise<unknown> {
  const bytes = await remote.read(path);
  if (!bytes) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/** What the cloud folder holds: a vault, nothing, or something broken. */
export async function inspectVault(
  remote: RemoteFolder,
): Promise<{ kind: "vault"; vault: VaultFile } | { kind: "empty" } | { kind: "damaged" }> {
  const raw = await readJson(remote, VAULT_PATH);
  if (raw === undefined) {
    const devices = await remote.list("devices");
    return devices.length > 0 ? { kind: "damaged" } : { kind: "empty" };
  }
  const vault = parseVaultFile(raw);
  return vault ? { kind: "vault", vault } : { kind: "damaged" };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** First device: a fresh vault. Returns the recovery key to show ONCE. */
export async function createVault(
  remote: RemoteFolder,
): Promise<{ binding: VaultBinding; recoveryKey: string }> {
  const found = await inspectVault(remote);
  if (found.kind === "vault") throw new VaultError("exists");
  if (found.kind === "damaged") throw new VaultError("damaged");
  const id = hex(randomBytes(16));
  const dk = randomBytes(32);
  const recovery = newRecoveryKeyBytes();
  const slot: KeySlot = { kind: "recovery", v: 1, ...(await wrapWithRecovery(dk, recovery, id)) };
  // The slot lands before the vault marker: a half-written vault reads as
  // "damaged" (devices may follow), never as a vault without a way in.
  await remote.write(RECOVERY_SLOT_PATH, encoder.encode(JSON.stringify(slot)));
  const vault: VaultFile = { format: "yuki-sync-vault", v: 1, id, createdAt: Date.now() };
  await remote.write(VAULT_PATH, encoder.encode(JSON.stringify(vault)));
  const keys = await deriveVaultKeys(dk);
  dk.fill(0);
  return { binding: { id, keys, mode: "creator" }, recoveryKey: formatRecoveryKey(recovery) };
}

/** Another device: open the vault with the recovery key. `pinned` is the
    fingerprint this device saw before (re-unlock after storage loss) — a
    different key behind the same folder is refused. */
export async function unlockVault(
  remote: RemoteFolder,
  recoveryText: string,
  pinned?: string,
): Promise<VaultBinding> {
  const recovery = parseRecoveryKey(recoveryText);
  if (!recovery) throw new VaultError("typo");
  const found = await inspectVault(remote);
  if (found.kind === "empty") throw new VaultError("missing");
  if (found.kind === "damaged") throw new VaultError("damaged");
  const slot = parseKeySlot(await readJson(remote, RECOVERY_SLOT_PATH));
  if (!slot) throw new VaultError("damaged");
  const dk = await unwrapWithRecovery(slot, recovery, found.vault.id);
  if (!dk) throw new VaultError("wrong");
  const keys = await deriveVaultKeys(dk);
  dk.fill(0);
  if (pinned !== undefined && pinned !== keys.fingerprint) throw new VaultError("changed");
  return { id: found.vault.id, keys, mode: "joiner" };
}

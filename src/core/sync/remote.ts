// The cloud as a dumb folder — the only thing a provider adapter implements
// (yandex.ts, dropbox.ts; tests use an in-memory one). Paths are relative to
// the app folder ("devices/<id>/state.bin"); the adapter maps them to its
// own addressing and creates parent folders as needed.

export interface RemoteEntry {
  path: string;
  /** Opaque version tag (provider revision / content hash): a changed tag
      means "download again". Never used to decide what to WRITE. */
  rev: string;
  size: number;
}

export type ProviderKind = "yandex" | "dropbox";

export interface RemoteFolder {
  readonly kind: ProviderKind | "memory";
  /** Every file under `dir`, recursively; [] when the folder doesn't exist. */
  list(dir: string): Promise<RemoteEntry[]>;
  /** File bytes, or null when the file doesn't exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Create or overwrite. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Start watching `dir`: every change from this moment on counts — so arm
      it BEFORE listing, and nothing written in between slips by. The wait
      it returns resolves on the first such change, or after a while anyway
      (a long-poll where the provider has one). Absent: poll on a timer. */
  watch?(dir: string): Promise<(signal: AbortSignal) => Promise<void>>;
}

/** The provider refused our credentials for good (revoked, expired refresh
    token): the user must connect again. Reading never stops for it. */
export class AuthRequiredError extends Error {
  constructor() {
    super("The cloud asks to sign in again");
    this.name = "AuthRequiredError";
  }
}

/** The provider is out of space for this user. */
export class QuotaError extends Error {
  constructor() {
    super("The cloud is full");
    this.name = "QuotaError";
  }
}

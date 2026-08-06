import { strFromU8, strToU8, Zip, ZipPassThrough } from "fflate";
import type { DictionaryRecord } from "../dictionaries";
import type { BookRecord, MangaRecord } from "../storage";

export interface BackupOptions {
  books: boolean;
  progress: boolean;
  stats: boolean;
  settings: boolean;
  dictionaries: boolean;
}

/** Which item is being processed right now — for the human-facing detail
    line ("Book 3 of 12 · page 145 of 226"), not for the bar. */
export interface BackupOperationItem {
  kind: "book" | "page";
  index: number;
  count: number;
}

export interface ResourceRef {
  path: string;
  mime: string;
  file: string;
}

export interface SerializedBookRecord
  extends Omit<BookRecord, "resources" | "pdfBytes"> {
  resources?: ResourceRef[];
  pdfFile?: string;
}

export interface MangaBackup {
  record: MangaRecord;
  pages: { file: string; mime: string }[];
  ocr: { page: number; file: string }[];
}

export interface BackupBook {
  id: string;
  recordFile: string;
  mangaFile?: string;
}

export interface BackupProgress {
  id: string;
  contentHash?: string;
  progress: number;
  lastReadAt?: number;
}

export interface BackupDictionary {
  record: DictionaryRecord;
  archiveFile: string;
}

export interface BackupManifest {
  format: "yuki-backup";
  version: 1;
  createdAt: number;
  options: BackupOptions;
  books?: BackupBook[];
  progress?: BackupProgress[];
  statsFile?: string;
  settingsFile?: string;
  dictionaries?: BackupDictionary[];
}

export const SETTINGS_KEYS = [
  "yuki-lang",
  "yuki:reading",
  "yuki:stats-goal",
  "yuki-shelf-sort",
  "yuki-shelf-collapsed",
  "yuki-shelf-group-order",
] as const;

export function json(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value));
}

export function readJson<T>(files: Record<string, Uint8Array>, path: string): T {
  if (!safePath(path)) throw new Error(`Backup contains an unsafe file path: ${path}`);
  const bytes = files[path];
  if (!bytes) throw new Error(`Backup is missing ${path}`);
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    throw new Error(`Backup contains invalid JSON: ${path}`);
  }
}

export function safePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.includes("\\")
  );
}

export function bytesAt(files: Record<string, Uint8Array>, path: unknown): Uint8Array {
  if (!safePath(path) || !files[path]) throw new Error(`Backup contains an unsafe file path: ${path}`);
  return files[path]!;
}

export function localSettings(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const result: Record<string, string> = {};
  for (const key of SETTINGS_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

export function restoreLocalSettings(settings: Record<string, string>): void {
  if (typeof window === "undefined") return;
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    if (typeof value === "string") window.localStorage.setItem(key, value);
  }
}

// The archive is streamed file by file instead of building one giant in-memory
// buffer: each item's bytes are pushed into the zip and released right away,
// so peak memory stays near the archive size instead of several times the
// library. Content is stored uncompressed — books are already-compressed
// formats (EPUB, JPEG, PDF), deflating them again only burns CPU.
export function createZipArchive(): {
  add: (name: string, data: Uint8Array) => void;
  finish: () => Promise<Blob>;
} {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  let onFinal: (() => void) | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure = err;
      onFinal?.();
      return;
    }
    chunks.push(chunk);
    if (final) onFinal?.();
  });
  return {
    add(name, data) {
      if (failure) throw failure;
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(data, true);
    },
    finish() {
      return new Promise<Blob>((resolve, reject) => {
        onFinal = () =>
          failure
            ? reject(failure)
            : resolve(new Blob(chunks as BlobPart[], { type: "application/zip" }));
        zip.end();
      });
    },
  };
}

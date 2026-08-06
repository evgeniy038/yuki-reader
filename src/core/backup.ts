import { DICTIONARIES_CHANGED_EVENT } from "./dictionaries";
import type { BackupImportSummary } from "./backup/import";
import type { BackupOperationItem, BackupOptions } from "./backup/format";
import { localSettings, restoreLocalSettings } from "./backup/format";
import { exportBackupInProcess } from "./backup/export";
import { importBackupInProcess } from "./backup/import";

// Facade over the backup/ modules: the archive format (manifest types,
// zip streaming, json/path helpers) lives in backup/format.ts, export in
// backup/export.ts, import in backup/import.ts and the ttsu fallback in
// backup/ttsu.ts. This file keeps the worker plumbing and the public tasks;
// import paths of existing consumers stay unchanged.

export type { BackupOptions } from "./backup/format";
export { DEFAULT_BACKUP_OPTIONS, exportBackupInProcess } from "./backup/export";
export type { BackupImportSummary } from "./backup/import";
export { importBackupInProcess } from "./backup/import";

export type BackupOperationProgressPhase =
  | "prepare"
  | "pack"
  | "unpack"
  | "restore";

export interface BackupOperationProgress {
  phase: BackupOperationProgressPhase;
  current: number;
  total: number;
  item?: BackupOperationItem;
}

export type BackupOperationProgressListener = (
  progress: BackupOperationProgress,
) => void;

/** Cooperative cancellation: checked at item boundaries (between books,
    between manga pages) — never mid-write, so the library stays consistent. */
export interface BackupCancelToken {
  cancelled: boolean;
}

export class BackupCancelledError extends Error {
  /** Set when an import had already restored some items before the cancel. */
  summary?: BackupImportSummary;
  constructor(summary?: BackupImportSummary) {
    super("Backup operation cancelled");
    this.name = "BackupCancelledError";
    this.summary = summary;
  }
}

export type BackupWorkerMessage =
  | {
      type: "export";
      options: Partial<BackupOptions>;
      settings: Record<string, string>;
    }
  | { type: "import"; buffer: ArrayBuffer }
  | { type: "cancel" };

export type BackupWorkerResponse =
  | { type: "progress"; progress: BackupOperationProgress }
  | { type: "exported"; buffer: ArrayBuffer }
  | { type: "imported"; summary: BackupImportSummary }
  | { type: "cancelled"; summary?: BackupImportSummary }
  | { type: "error"; message: string };

// If the worker goes silent (killed on memory pressure, deadlocked on a
// blocked database) its promise would never settle — without a watchdog the
// dialog would spin forever. Silence longer than this is a hard failure.
const BACKUP_STALL_TIMEOUT_MS = 120_000;

interface BackupWorkerTask {
  result: Promise<BackupWorkerResponse>;
  /** "terminate" kills the worker outright (export — nothing is written, so
      instant cancel is safe); "cooperative" asks the worker to stop at the
      next item boundary (import — mid-write cancellation must stay atomic). */
  cancel: () => void;
}

function runBackupWorker(
  message: BackupWorkerMessage,
  transfer: Transferable[] = [],
  onProgress?: BackupOperationProgressListener,
  cancelMode: "terminate" | "cooperative" = "cooperative",
): BackupWorkerTask {
  const worker = new Worker(new URL("./backup.worker.ts", import.meta.url), {
    type: "module",
  });
  let cancelRequested = false;
  let rejectResult: ((cause: Error) => void) | null = null;
  let stallTimer: ReturnType<typeof setTimeout>;
  const finish = () => {
    clearTimeout(stallTimer);
    worker.terminate();
  };
  const result = new Promise<BackupWorkerResponse>((resolve, reject) => {
    rejectResult = reject;
    const armWatchdog = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        finish();
        reject(new Error("Backup operation stalled"));
      }, BACKUP_STALL_TIMEOUT_MS);
    };
    worker.onmessage = (event: MessageEvent<BackupWorkerResponse>) => {
      armWatchdog();
      if (event.data.type === "progress") {
        onProgress?.(event.data.progress);
        return;
      }
      finish();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Backup worker failed"));
    };
    armWatchdog();
    worker.postMessage(message, transfer);
  });
  return {
    result,
    cancel: () => {
      if (cancelRequested) return;
      cancelRequested = true;
      if (cancelMode === "terminate") {
        finish();
        rejectResult?.(new BackupCancelledError());
        return;
      }
      worker.postMessage({ type: "cancel" });
    },
  };
}

export interface BackupTask<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function cancelledOrThrow(result: BackupWorkerResponse): void {
  if (result.type === "cancelled") {
    throw new BackupCancelledError(result.summary);
  }
  if (result.type === "error") throw new Error(result.message);
}

export function exportBackupTask(
  requested: Partial<BackupOptions> = {},
  onProgress?: BackupOperationProgressListener,
): BackupTask<Blob> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    const token: BackupCancelToken = { cancelled: false };
    return {
      promise: exportBackupInProcess(requested, localSettings(), onProgress, token),
      cancel: () => {
        token.cancelled = true;
      },
    };
  }
  const task = runBackupWorker(
    { type: "export", options: requested, settings: localSettings() },
    [],
    onProgress,
    "terminate",
  );
  return {
    promise: task.result.then((result) => {
      cancelledOrThrow(result);
      if (result.type !== "exported") throw new Error("Backup export failed");
      return new Blob([result.buffer], { type: "application/zip" });
    }),
    cancel: task.cancel,
  };
}

export function importBackupTask(
  file: Blob,
  onProgress?: BackupOperationProgressListener,
): BackupTask<BackupImportSummary> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    const token: BackupCancelToken = { cancelled: false };
    return {
      promise: (async () => {
        const summary = await importBackupInProcess(file, onProgress, token);
        if (summary.dictionaries > 0 && typeof window !== "undefined") {
          window.dispatchEvent(new Event(DICTIONARIES_CHANGED_EVENT));
        }
        return summary;
      })(),
      cancel: () => {
        token.cancelled = true;
      },
    };
  }
  let task: BackupWorkerTask | null = null;
  let cancelRequested = false;
  return {
    promise: (async () => {
      const buffer = await file.arrayBuffer();
      // A cancel clicked while the file was being read (before the worker
      // exists) must not be lost.
      if (cancelRequested) throw new BackupCancelledError();
      task = runBackupWorker({ type: "import", buffer }, [buffer], onProgress);
      if (cancelRequested) task.cancel();
      const result = await task.result;
      cancelledOrThrow(result);
      if (result.type !== "imported") throw new Error("Backup import failed");
      if (result.summary.settings) restoreLocalSettings(result.summary.settings);
      if (result.summary.dictionaries > 0) {
        window.dispatchEvent(new Event(DICTIONARIES_CHANGED_EVENT));
      }
      return result.summary;
    })(),
    cancel: () => {
      cancelRequested = true;
      task?.cancel();
    },
  };
}

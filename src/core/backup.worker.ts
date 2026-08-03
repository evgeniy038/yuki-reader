import {
  BackupCancelledError,
  exportBackupInProcess,
  importBackupInProcess,
  type BackupCancelToken,
  type BackupWorkerMessage,
  type BackupWorkerResponse,
} from "./backup";

const post = (message: BackupWorkerResponse, transfer?: Transferable[]) =>
  (
    self as unknown as {
      postMessage(message: BackupWorkerResponse, transfer?: Transferable[]): void;
    }
  ).postMessage(
    message,
    transfer,
  );

// Cooperative cancel: the flag is checked at item boundaries (between books,
// between manga pages) — never mid-write, so a cancelled import still leaves
// the library consistent.
const token: BackupCancelToken = { cancelled: false };

self.onmessage = async (event: MessageEvent<BackupWorkerMessage>) => {
  if (event.data.type === "cancel") {
    token.cancelled = true;
    return;
  }
  try {
    if (event.data.type === "export") {
      const blob = await exportBackupInProcess(
        event.data.options,
        event.data.settings,
        (progress) => post({ type: "progress", progress }),
        token,
      );
      const buffer = await blob.arrayBuffer();
      post(
        { type: "exported", buffer } satisfies BackupWorkerResponse,
        [buffer],
      );
      return;
    }

    const summary = await importBackupInProcess(
      new Blob([event.data.buffer]),
      (progress) => post({ type: "progress", progress }),
      token,
    );
    post({ type: "imported", summary } satisfies BackupWorkerResponse);
  } catch (cause) {
    if (cause instanceof BackupCancelledError) {
      post({
        type: "cancelled",
        ...(cause.summary ? { summary: cause.summary } : {}),
      } satisfies BackupWorkerResponse);
      return;
    }
    post({
      type: "error",
      message: cause instanceof Error ? cause.message : "Backup operation failed",
    } satisfies BackupWorkerResponse);
  }
};

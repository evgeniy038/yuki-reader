import {
  exportBackupInProcess,
  importBackupInProcess,
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

self.onmessage = async (event: MessageEvent<BackupWorkerMessage>) => {
  try {
    if (event.data.type === "export") {
      const blob = await exportBackupInProcess(
        event.data.options,
        event.data.settings,
      );
      const buffer = await blob.arrayBuffer();
      post(
        { type: "exported", buffer } satisfies BackupWorkerResponse,
        [buffer],
      );
      return;
    }

    const summary = await importBackupInProcess(new Blob([event.data.buffer]));
    post({ type: "imported", summary } satisfies BackupWorkerResponse);
  } catch (cause) {
    post({
      type: "error",
      message: cause instanceof Error ? cause.message : "Backup operation failed",
    } satisfies BackupWorkerResponse);
  }
};

import {
  importDictionaryArchive,
  type DictionaryImportOptions,
  type DictionaryProgress,
  type DictionaryRecord,
} from "./dictionaries";

type DictionaryWorkerMessage = {
  type: "import";
  archive: ArrayBuffer;
  options: DictionaryImportOptions;
};

type DictionaryWorkerResponse =
  | { type: "progress"; progress: DictionaryProgress }
  | { type: "done"; record: DictionaryRecord }
  | { type: "error"; message: string };

self.onmessage = async (event: MessageEvent<DictionaryWorkerMessage>) => {
  try {
    const record = await importDictionaryArchive(
      new Uint8Array(event.data.archive),
      event.data.options,
      (progress) => {
        self.postMessage({ type: "progress", progress } satisfies DictionaryWorkerResponse);
      },
    );
    self.postMessage({ type: "done", record } satisfies DictionaryWorkerResponse);
  } catch (cause) {
    self.postMessage({
      type: "error",
      message: cause instanceof Error ? cause.message : "Dictionary import failed",
    } satisfies DictionaryWorkerResponse);
  }
};

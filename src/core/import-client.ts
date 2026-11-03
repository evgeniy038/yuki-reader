import { importBookFile, type ImportedBookFile } from "./import-book";
import {
  importMangaItems,
  type ImportedMangaVolume,
  type MangaInputItem,
} from "./import-manga";
import type { ImportWorkerIn, ImportWorkerOut } from "./import.worker";

// Main-thread side of the import worker: a small pool (a batch of EPUBs
// parses in parallel; a phone gets one worker — memory), each worker taking
// one file at a time. Workers end after a quiet spell so an import never
// pins their heaps for the rest of the session. PDFs stay on this thread:
// pdf.js renders the cover with a page canvas and has its own worker
// anyway. Without Worker support (node tests) everything runs in-process.

const IDLE_MS = 15_000;
const POOL = Math.max(
  1,
  Math.min(3, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 4)),
);

interface Slot {
  worker: Worker;
  busy: boolean;
  idle: ReturnType<typeof setTimeout> | null;
}

type Job = {
  message: ImportWorkerIn;
  resolve: (out: ImportWorkerOut) => void;
  reject: (err: Error) => void;
};

const slots: Slot[] = [];
const queue: Job[] = [];
const running = new Map<Slot, Job>();
let nextId = 0;

function retire(slot: Slot): void {
  slot.worker.terminate();
  slots.splice(slots.indexOf(slot), 1);
}

function spawn(): Slot {
  const slot: Slot = {
    worker: new Worker(new URL("./import.worker.ts", import.meta.url), {
      type: "module",
    }),
    busy: false,
    idle: null,
  };
  slot.worker.onmessage = (event: MessageEvent<ImportWorkerOut>) => {
    const job = running.get(slot);
    running.delete(slot);
    slot.busy = false;
    job?.resolve(event.data);
    pump();
  };
  slot.worker.onerror = (event) => {
    const job = running.get(slot);
    running.delete(slot);
    retire(slot);
    job?.reject(new Error(event.message || "import worker crashed"));
    pump();
  };
  slots.push(slot);
  return slot;
}

function pump(): void {
  while (queue.length > 0) {
    const slot =
      slots.find((s) => !s.busy) ?? (slots.length < POOL ? spawn() : undefined);
    if (!slot) return;
    const job = queue.shift()!;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    slot.busy = true;
    running.set(slot, job);
    slot.worker.postMessage(job.message);
  }
  for (const slot of slots) {
    if (!slot.busy && !slot.idle) {
      slot.idle = setTimeout(() => retire(slot), IDLE_MS);
    }
  }
}

function run(message: ImportWorkerIn): Promise<ImportWorkerOut> {
  return new Promise((resolve, reject) => {
    queue.push({ message, resolve, reject });
    pump();
  });
}

const failed = (out: ImportWorkerOut): Error =>
  new Error(out.type === "error" ? out.message : "import failed");

/** importBookFile, EPUBs off the main thread. */
export async function importBook(file: File): Promise<ImportedBookFile> {
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf || typeof Worker === "undefined") return importBookFile(file);
  const out = await run({ type: "book", id: nextId++, file });
  if (out.type !== "book") throw failed(out);
  return out.result;
}

/** importMangaItems off the main thread. */
export async function importManga(
  items: MangaInputItem[],
): Promise<ImportedMangaVolume[]> {
  if (typeof Worker === "undefined") return importMangaItems(items);
  const out = await run({ type: "manga", id: nextId++, items });
  if (out.type !== "manga") throw failed(out);
  return out.volumes;
}

import { useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { MangaInputItem } from "@/core/import-manga";

// File drag & drop over the whole app shell. The depth counter tracks nested
// enter/leave pairs so the overlay doesn't flicker when crossing child
// boundaries. A drop carries EVERYTHING that was dragged: plain files, and
// folders walked recursively (a manga volume is usually a folder of scans).

interface WebkitEntry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (callback: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      callback: (entries: WebkitEntry[]) => void,
      error?: (err: unknown) => void,
    ) => void;
  };
}

function entryFile(entry: WebkitEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file?.(resolve, () => resolve(null));
  });
}

async function walkEntry(
  entry: WebkitEntry,
  out: MangaInputItem[],
): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry);
    if (file) {
      out.push({ file, path: entry.fullPath.replace(/^\/+/, "") || file.name });
    }
    return;
  }
  if (entry.isDirectory) {
    // readEntries returns batches — loop until an empty one.
    const reader = entry.createReader?.();
    if (!reader) return;
    for (;;) {
      const batch = await new Promise<WebkitEntry[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) return;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

async function itemsFromDrop(dt: DataTransfer): Promise<MangaInputItem[]> {
  const entries = [...dt.items]
    .map((item) => (item as { webkitGetAsEntry?: () => WebkitEntry | null }).webkitGetAsEntry?.())
    .filter((entry): entry is WebkitEntry => entry != null);
  if (entries.length === 0) {
    return [...dt.files].map((file) => ({
      file,
      path: file.name,
    }));
  }
  const out: MangaInputItem[] = [];
  for (const entry of entries) await walkEntry(entry, out);
  return out;
}

export function useFileDrop(onFiles: (items: MangaInputItem[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  const handlers = useMemo(
    () => ({
      onDragEnter(event: DragEvent<HTMLDivElement>) {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        depthRef.current += 1;
        setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLDivElement>) {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
      },
      onDragLeave() {
        depthRef.current -= 1;
        if (depthRef.current <= 0) {
          depthRef.current = 0;
          setDragging(false);
        }
      },
      onDrop(event: DragEvent<HTMLDivElement>) {
        event.preventDefault();
        depthRef.current = 0;
        setDragging(false);
        void itemsFromDrop(event.dataTransfer).then((items) => {
          if (items.length > 0) onFilesRef.current(items);
        });
      },
    }),
    [],
  );

  return { dragging, handlers };
}

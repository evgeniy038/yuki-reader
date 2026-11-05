import { useEffect, useState } from "react";
import type { MokuroBlock } from "@/core/mokuro";
import { enqueueDetect, onOcrPage } from "@/core/ocr/ocr";
import { loadMangaOcr, type MangaRecord } from "@/core/storage";

// In-app OCR blocks for pages that came without a sidecar (0-based index).
export function useMangaOcrBlocks(
  bookId: string,
  record: MangaRecord | null,
): Map<number, MokuroBlock[]> {
  const [ocrBlocks, setOcrBlocks] = useState<Map<number, MokuroBlock[]>>(
    new Map(),
  );

  // In-app OCR for sidecar-less pages (lazy): attach what's already computed,
  // queue detect-only skeletons for the rest as a safety net (the import and
  // the resume pass normally beat the reader to it), and attach fresh results
  // live as the worker finishes pages. Recognition itself is the background
  // march (ocr.ts) plus hover — nothing here re-prioritizes the queue.
  useEffect(() => {
    if (!record) return;
    let alive = true;
    const missing = record.pages.flatMap((meta, index) =>
      meta.blocks && meta.blocks.length > 0 ? [] : [index],
    );
    void loadMangaOcr(bookId).then((map) => {
      // Merge, never replace: live page events may have landed after the
      // storage snapshot was taken — they are newer and must win.
      if (alive && map.size > 0) {
        const blocksMap = new Map(
          [...map].map(([index, rec]) => [index, rec.blocks]),
        );
        setOcrBlocks((prev) => new Map([...blocksMap, ...prev]));
      }
    });
    // A received volume is recognized on the device it came from.
    if (missing.length > 0 && !record.received) {
      enqueueDetect(bookId, missing);
    }
    const unsubscribe = onOcrPage((doneBookId, pageIndex, blocks) => {
      if (doneBookId !== bookId) return;
      setOcrBlocks((prev) => new Map(prev).set(pageIndex, blocks));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [record, bookId]);

  return ocrBlocks;
}

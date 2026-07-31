import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  loadPdfOutline,
  openPdf,
  type PdfOutlineEntry,
} from "@/core/pdf";

// The PDF document lifecycle: load once per byte source, destroy on teardown
// (including the race where a newer load wins). Reports the restored page
// derived from the stored 0..1 progress — restores exactly, at any window
// size and across spread/single switches. The outline lands async after the
// document (null until then).
export function usePdfDocument(
  pdfBytes: Uint8Array,
  initialProgress: number,
) {
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  /** First page to show once the doc is ready; 0 = not loaded yet. */
  const [restoredPage, setRestoredPage] = useState(0);
  const [failed, setFailed] = useState(false);
  const [outline, setOutline] = useState<PdfOutlineEntry[] | null>(null);

  useEffect(() => {
    let active = true;
    openPdf(pdfBytes)
      .then(({ doc: loaded, numPages: count }) => {
        if (!active) {
          void loaded.destroy();
          return;
        }
        docRef.current = loaded;
        const restored =
          count > 1
            ? Math.min(count, Math.max(1, Math.round(initialProgress * (count - 1)) + 1))
            : 1;
        setNumPages(count);
        setRestoredPage(restored);
        setDoc(loaded);
        void loadPdfOutline(loaded).then((entries) => {
          if (!active) return;
          setOutline(entries);
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      const current = docRef.current;
      docRef.current = null;
      if (current) void current.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes]);

  return { doc, numPages, restoredPage, failed, outline };
}

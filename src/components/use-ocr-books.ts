import { useEffect, useState } from "react";
import { onOcrBooks, type OcrBookProgress } from "@/core/ocr/ocr";

/** Per-volume OCR progress (storage truth), live. The queue panel and the
    shelf gate both read from this — never from queue length. */
export function useOcrBooks(): OcrBookProgress[] {
  const [books, setBooks] = useState<OcrBookProgress[]>([]);
  useEffect(() => onOcrBooks(setBooks), []);
  return books;
}

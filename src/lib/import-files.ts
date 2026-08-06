import type { MangaInputItem } from "@/core/import-manga";

// Picked files become import items: the picker-relative path (a directory
// pick preserves the folder layout) when present, else the bare file name.
export function importItemsOf(files: File[]): MangaInputItem[] {
  return files.map((file) => ({
    file,
    path:
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name,
  }));
}

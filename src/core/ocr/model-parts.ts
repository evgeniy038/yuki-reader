// Static hosts cap a single file (Cloudflare Pages: 25 MiB), and the OCR
// models run 30–87 MB. A model above MODEL_PART_BYTES therefore ships as
// numbered parts `<file>.part0`, `.part1`, … — cut at build time and served
// the same way by the dev server (vite.config.ts), joined back by the
// downloader (download.ts). The cache still keeps one whole file per model.

export const MODEL_PART_BYTES = 20 * 1024 * 1024;

/** How many parts a file of `size` bytes ships as (1 = not split). */
export const modelParts = (size: number): number =>
  Math.max(1, Math.ceil(size / MODEL_PART_BYTES));

export const partUrl = (url: string, index: number): string => `${url}.part${index}`;

/** Byte range [start, end) of part `index`. */
export function partRange(size: number, index: number): { start: number; end: number } {
  const start = index * MODEL_PART_BYTES;
  return { start, end: Math.min(size, start + MODEL_PART_BYTES) };
}

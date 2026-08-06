// Image MIME lookup by file extension — one table for every reader of image
// files (manga archives, EPUB resources, backup page entries). An unknown
// extension defers to the caller's fallback, so each call site keeps its own
// policy (octet-stream, undefined, a sniffed File type).

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** Image MIME for a file name by its extension; `fallback` when unknown. */
export function mimeFromExtension(name: string, fallback: string): string;
export function mimeFromExtension(
  name: string,
  fallback?: undefined,
): string | undefined;
export function mimeFromExtension(
  name: string,
  fallback?: string,
): string | undefined {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

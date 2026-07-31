// .mokuro sidecar files: OCR text boxes aligned to manga page images.
// The format is version-tolerant in practice (0.1.x/0.2.x share the shape we
// read), so parsing accepts any `version` and only checks the fields we use.
// Coordinates are pixels in the ORIGINAL image space — the reader scales the
// whole overlay to the displayed page size.

export interface MokuroBlock {
  /** [x1, y1, x2, y2] in source-image pixels. */
  box: [number, number, number, number];
  vertical: boolean;
  font_size: number;
  lines: string[];
}

export interface MokuroPage {
  img_width: number;
  img_height: number;
  img_path: string;
  blocks: MokuroBlock[];
}

export interface MokuroData {
  /** Volume label written by the OCR tool (usually the folder name). */
  volume?: string;
  pages: MokuroPage[];
}

function toBlock(raw: unknown): MokuroBlock | null {
  if (raw == null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const box = value.box;
  if (!Array.isArray(box) || box.length < 4) return null;
  const nums = box.slice(0, 4).map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = nums as [number, number, number, number];
  const lines = Array.isArray(value.lines)
    ? value.lines.filter((line): line is string => typeof line === "string")
    : [];
  return {
    box: [x1, y1, x2, y2],
    vertical: value.vertical === true,
    font_size: Number(value.font_size) || 16,
    lines,
  };
}

function toPage(raw: unknown): MokuroPage | null {
  if (raw == null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const width = Number(value.img_width);
  const height = Number(value.img_height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const blocks = Array.isArray(value.blocks)
    ? value.blocks.map(toBlock).filter((b): b is MokuroBlock => b !== null)
    : [];
  return {
    img_width: width,
    img_height: height,
    img_path: typeof value.img_path === "string" ? value.img_path : "",
    blocks,
  };
}

/** Parse a .mokuro file body; returns null when the shape isn't there. */
export function parseMokuro(text: string): MokuroData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw == null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.pages)) return null;
  const pages = value.pages
    .map(toPage)
    .filter((page): page is MokuroPage => page !== null);
  return {
    volume: typeof value.volume === "string" ? value.volume : undefined,
    pages,
  };
}

/** OCR page lookup key: the image file name, path separators normalized. */
export function mokuroImageKey(imgPath: string): string {
  const normalized = imgPath.replace("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Natural ordering ("2" before "10") with fullwidth digits folded to ASCII —
// page scans and volume numbers come in both width variants.

export function foldFullwidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
  );
}

export function naturalCompare(a: string, b: string): number {
  const left = foldFullwidthDigits(a).split(/(\d+)/);
  const right = foldFullwidthDigits(b).split(/(\d+)/);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = left[i] ?? "";
    const y = right[i] ?? "";
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (x !== "" && y !== "" && Number.isFinite(nx) && Number.isFinite(ny)) {
      return nx - ny;
    }
    return x.localeCompare(y, "ja");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Series / volume derivation from a file or folder name. Real-world names:
//   "[Author] Title 第01巻"        → series "Title", volume 1
//   "Title v05" / "Title_vol. 5"   → volume 5
//   "Name_3" / "Name 3"            → volume 3
// Drive-export suffixes ("…-20260731T164242Z-1-001") are junk and dropped.

const AUTHOR_PREFIX = /^(?:\[[^\]]*\]\s*)+/;
const DRIVE_SUFFIX = /-\d{8}T\d{6}Z(?:-\d+)+$/;
const VOLUME_MARKERS = [
  /第\s*([0-9０-９]+)\s*巻.*$/,
  /(?:^|[_\s#])v(?:ol)?\.?\s*([0-9０-９]+)\b.*$/i,
  /[#_]([0-9０-９]+)\s*$/,
  /\s([0-9０-９]+)\s*$/,
];

export function cleanVolumeName(rawName: string): string {
  return rawName
    .replace(/\.(zip|cbz|mokuro|html?)$/i, "")
    .replace(DRIVE_SUFFIX, "")
    .trim();
}

export function splitSeriesVolume(rawName: string): {
  series: string;
  volumeIndex?: number;
} {
  let name = cleanVolumeName(rawName).replace(AUTHOR_PREFIX, "").trim();
  for (const marker of VOLUME_MARKERS) {
    const match = name.match(marker);
    if (!match || match.index === undefined) continue;
    const volumeIndex = Number(foldFullwidthDigits(match[1] ?? ""));
    const series = name
      .slice(0, match.index)
      .replace(/[\s_\-–—.]+$/, "")
      .trim();
    if (series === "" || !Number.isFinite(volumeIndex)) continue;
    return { series, volumeIndex };
  }
  return { series: name };
}

/** Series matching key: case- and width-insensitive, spacing folded. */
export function normalizeSeriesKey(series: string): string {
  return foldFullwidthDigits(series)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

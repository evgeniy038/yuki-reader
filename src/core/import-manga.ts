import { sha256Hex } from "./book-hash";
import { blobToDataUrl } from "./data-url";
import { mimeFromExtension } from "./mime";
import { byOffset, openZip } from "./zip-entries";
import {
  cleanVolumeName,
  mokuroImageKey,
  naturalCompare,
  parseMokuro,
  splitSeriesVolume,
  type MokuroBlock,
  type MokuroData,
} from "./mokuro";

// Manga import pipeline: whatever the user has — a zip/cbz of page scans, a
// folder of images, an OCR sidecar (.mokuro) next to them — becomes one or
// more VOLUMES. Archives never execute anything: only image entries (and an
// embedded sidecar) are read, everything else (.url, .txt, __MACOSX) is
// skipped by extension. Pages keep reading order via natural name sort;
// sidecar boxes attach to pages by image file name.

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const ZIP_EXT = /\.(zip|cbz)$/i;
const MOKURO_EXT = /\.mokuro$/i;

export interface MangaInputItem {
  file: File;
  /** Relative path (drop traversal / webkitRelativePath); falls back to name. */
  path: string;
}

export interface MangaStoredPage {
  /** Image file name — the blob key suffix and the sidecar match key. */
  path: string;
  img_width?: number;
  img_height?: number;
  blocks?: MokuroBlock[];
}

export interface ImportedMangaVolume {
  /** Display title of the volume (cleaned file/folder name). */
  volumeName: string;
  series: string;
  volumeIndex?: number;
  /** Page metadata in reading order, aligned with `blobs`. */
  pages: MangaStoredPage[];
  blobs: Blob[];
  cover?: string;
  contentHash: string;
}

export function isMangaItem(item: MangaInputItem): boolean {
  const name = item.file.name;
  return (
    ZIP_EXT.test(name) ||
    MOKURO_EXT.test(name) ||
    IMAGE_EXT.test(name) ||
    item.file.type.startsWith("image/")
  );
}

function mimeOf(name: string, fallback: string): string {
  return (
    mimeFromExtension(name) ??
    (fallback.startsWith("image/") ? fallback : "image/jpeg")
  );
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Drop the single shared top-level folder archives usually carry. */
function stripCommonRoot(paths: string[]): string[] {
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  if (roots.size !== 1) return paths;
  const root = [...roots][0]!;
  return paths.map((path) =>
    path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
  );
}

interface RawVolume {
  volumeName: string;
  images: { path: string; blob: Blob }[];
  mokuro?: MokuroData;
}

/** One archive = one volume: image entries in natural reading order. The
    archive is read lazily (zip-entries): only its directory and the page
    entries, one at a time — never the whole file in memory. */
async function volumeFromZip(file: File): Promise<RawVolume | null> {
  const zip = await openZip(file);
  const names = [...zip.entries.keys()].filter(
    (name) => !name.endsWith("/") && !name.startsWith("__MACOSX/"),
  );
  const imageNames = names.filter((name) => IMAGE_EXT.test(baseName(name)));
  if (imageNames.length === 0) return null;
  const stripped = stripCommonRoot(imageNames);
  const order = imageNames
    .map((name, index) => ({ name, stripped: stripped[index]! }))
    .sort((a, b) => naturalCompare(a.stripped, b.stripped));
  const blobs = new Map<string, Blob>();
  for (const name of byOffset(zip.entries, imageNames)) {
    blobs.set(name, await zip.blob(zip.entries.get(name)!, mimeOf(name, "")));
  }
  const images = order.map(({ name, stripped }) => ({
    path: baseName(stripped),
    blob: blobs.get(name)!,
  }));
  const mokuroName = names.find((name) => MOKURO_EXT.test(baseName(name)));
  const mokuro = mokuroName
    ? (parseMokuro(
        new TextDecoder().decode(await zip.bytes(zip.entries.get(mokuroName)!)),
      ) ?? undefined)
    : undefined;
  return { volumeName: cleanVolumeName(file.name), images, mokuro };
}

/** Loose files: images grouped by their top-level folder, sidecars paired
    to a group by folder name, sidecar volume label, or file base name. */
async function volumesFromLoose(items: MangaInputItem[]): Promise<RawVolume[]> {
  const groups = new Map<string, { path: string; blob: Blob }[]>();
  const sidecars: { dir: string; base: string; data: MokuroData }[] = [];
  for (const item of items) {
    const rel = item.path.replace(/^\/+/, "");
    const dir = rel.includes("/") ? rel.split("/")[0]! : "";
    if (MOKURO_EXT.test(item.file.name)) {
      const data = parseMokuro(await item.file.text());
      if (data) {
        sidecars.push({
          dir,
          base: cleanVolumeName(baseName(rel)),
          data,
        });
      }
      continue;
    }
    if (!IMAGE_EXT.test(item.file.name) && !item.file.type.startsWith("image/"))
      continue;
    const list = groups.get(dir) ?? [];
    list.push({
      path: baseName(rel),
      blob: item.file.slice(0, item.file.size, mimeOf(item.file.name, item.file.type)),
    });
    groups.set(dir, list);
  }
  return [...groups.entries()].map(([dir, images]) => {
    // Pair a sidecar to this group: same folder first, then a root-level
    // file named like the folder, then the sidecar's own volume label.
    const sidecar =
      sidecars.find((s) => s.dir === dir && dir !== "") ??
      sidecars.find((s) => s.base.toLowerCase() === dir.toLowerCase()) ??
      sidecars.find(
        (s) =>
          s.data.volume !== undefined &&
          s.data.volume.toLowerCase() === dir.toLowerCase(),
      ) ??
      (groups.size === 1 ? sidecars[0] : undefined);
    return {
      volumeName: cleanVolumeName(dir === "" ? (sidecar?.data.volume ?? "Manga") : dir),
      images: images.sort((a, b) => naturalCompare(a.path, b.path)),
      mokuro: sidecar?.data,
    };
  });
}

function alignMokuro(volume: RawVolume): {
  pages: MangaStoredPage[];
  blobs: Blob[];
} {
  const byName = new Map<string, MokuroData["pages"][number]>();
  if (volume.mokuro) {
    for (const page of volume.mokuro.pages) {
      byName.set(mokuroImageKey(page.img_path), page);
    }
  }
  const pages: MangaStoredPage[] = volume.images.map((image) => {
    const ocr = byName.get(image.path);
    return {
      path: image.path,
      img_width: ocr?.img_width,
      img_height: ocr?.img_height,
      blocks: ocr?.blocks,
    };
  });
  return { pages, blobs: volume.images.map((image) => image.blob) };
}

/** Downscaled first page as the shelf cover (best-effort; an
    OffscreenCanvas, so it runs inside the import worker too). */
async function makeCover(blob: Blob): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await blobToDataUrl(
      await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }),
    );
  } catch {
    return undefined;
  }
}

async function volumeHash(
  volumeName: string,
  pages: MangaStoredPage[],
  blobs: Blob[],
): Promise<string> {
  const material = [
    volumeName,
    ...pages.map((page, i) => `${page.path}:${blobs[i]?.size ?? 0}`),
  ].join("\n");
  return sha256Hex(material);
}

/** Raw volume → shelf-ready volume: sidecar boxes aligned, series and
    volume number split from the name, cover and dedupe hash made. */
async function finishVolume(raw: RawVolume): Promise<ImportedMangaVolume | null> {
  const { pages, blobs } = alignMokuro(raw);
  if (pages.length === 0) return null;
  const { series, volumeIndex } = splitSeriesVolume(
    raw.mokuro?.volume && raw.volumeName === "Manga"
      ? raw.mokuro.volume
      : raw.volumeName,
  );
  return {
    volumeName: raw.volumeName,
    series,
    volumeIndex,
    pages,
    blobs,
    cover: blobs[0] ? await makeCover(blobs[0]) : undefined,
    contentHash: await volumeHash(raw.volumeName, pages, blobs),
  };
}

/** An image-only EPUB (see epub-manga) as one volume, pages in spine order. */
export async function mangaVolumeFromEpub(
  volumeName: string,
  pages: { path: string; blob: Blob }[],
): Promise<ImportedMangaVolume | null> {
  return finishVolume({
    volumeName: cleanVolumeName(volumeName),
    images: pages.map((page) => ({ path: baseName(page.path), blob: page.blob })),
  });
}

/** Import a mixed drop/selection: archives become volumes one-by-one, loose
    images and sidecars group into volumes by their top-level folder. */
export async function importMangaItems(
  items: MangaInputItem[],
): Promise<ImportedMangaVolume[]> {
  const rawVolumes: RawVolume[] = [];
  const loose: MangaInputItem[] = [];
  for (const item of items) {
    if (ZIP_EXT.test(item.file.name)) {
      const volume = await volumeFromZip(item.file);
      if (volume) rawVolumes.push(volume);
    } else {
      loose.push(item);
    }
  }
  if (loose.length > 0) rawVolumes.push(...(await volumesFromLoose(loose)));

  const out: ImportedMangaVolume[] = [];
  for (const raw of rawVolumes) {
    const volume = await finishVolume(raw);
    if (volume) out.push(volume);
  }
  return out;
}

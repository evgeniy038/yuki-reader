// Pixel source for the OCR quality harness. The app resamples every model
// input (the detector's 640² page, each 224² crop) with an OffscreenCanvas
// drawImage in its worker — Chrome's resampler, not sharp's. A
// downscale's antialiasing decides what the encoder sees, so the harness
// asks a real headless Chrome for the exact RGBA the app would get
// (`--canvas chrome`, the default); `--canvas sharp` keeps the old
// libvips path for comparison.
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";

export interface Rect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface PixelSource {
  /** Load one page; later calls resample from it. */
  page(buf: Buffer): Promise<{ width: number; height: number }>;
  /** RGBA of `rects` of the current page, each resampled to w×h (h = w
      when omitted). */
  rgba(rects: Rect[], w: number, h?: number): Promise<Uint8Array[]>;
  close(): Promise<void>;
}

// Runs inside the page: decode once per page, then crop+resample on an
// OffscreenCanvas exactly like src/core/ocr/detect.ts chwPixels (one
// scratch canvas per size, drawImage, getImageData). `quality` null leaves
// the context default, as the app does today.
const PAGE_SCRIPT = `
window.__yuki = {
  bmp: null,
  canvases: new Map(),
  async page(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (this.bmp) this.bmp.close();
    this.bmp = await createImageBitmap(new Blob([bytes]));
    return { width: this.bmp.width, height: this.bmp.height };
  },
  rgba(rects, w, h, quality) {
    const key = w + "x" + h;
    let entry = this.canvases.get(key);
    if (!entry) {
      const canvas = new OffscreenCanvas(w, h);
      entry = { canvas, ctx: canvas.getContext("2d") };
      this.canvases.set(key, entry);
    }
    const { ctx } = entry;
    if (quality) ctx.imageSmoothingQuality = quality;
    let bin = "";
    for (const r of rects) {
      ctx.drawImage(this.bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0; i < data.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  },
};`;

class ChromeSource implements PixelSource {
  private constructor(
    private browser: Browser,
    private tab: Page,
    private quality: string | null,
  ) {}

  static async open(quality: string | null): Promise<ChromeSource> {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const tab = await browser.newPage();
    await tab.goto("about:blank");
    await tab.evaluate(PAGE_SCRIPT);
    return new ChromeSource(browser, tab, quality);
  }

  async page(buf: Buffer) {
    return this.tab.evaluate(
      `window.__yuki.page(${JSON.stringify(buf.toString("base64"))})`,
    ) as Promise<{ width: number; height: number }>;
  }

  async rgba(rects: Rect[], w: number, h = w): Promise<Uint8Array[]> {
    if (rects.length === 0) return [];
    const b64 = (await this.tab.evaluate(
      `window.__yuki.rgba(${JSON.stringify(rects)}, ${w}, ${h}, ${JSON.stringify(this.quality)})`,
    )) as string;
    const all = Buffer.from(b64, "base64");
    const plane = w * h * 4;
    return rects.map((_, i) => new Uint8Array(all.buffer, all.byteOffset + i * plane, plane));
  }

  async close() {
    await this.browser.close();
  }
}

class SharpSource implements PixelSource {
  private img: sharp.Sharp | null = null;

  async page(buf: Buffer) {
    this.img = sharp(buf);
    const meta = await this.img.metadata();
    return { width: meta.width!, height: meta.height! };
  }

  async rgba(rects: Rect[], w: number, h = w): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const r of rects) {
      const { data } = await this.img!
        .clone()
        .extract({ left: r.sx, top: r.sy, width: r.sw, height: r.sh })
        .resize(w, h, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      out.push(new Uint8Array(data));
    }
    return out;
  }

  async close() {}
}

export async function openPixelSource(
  kind: string,
  quality: string | null,
): Promise<PixelSource> {
  if (kind === "sharp") return new SharpSource();
  if (kind === "chrome") return ChromeSource.open(quality);
  throw new Error(`unknown --canvas ${kind} (chrome|sharp)`);
}

/** RGBA → CHW float32, 1:1 with src/core/ocr/detect.ts chwPixels:
    normalize maps v to v*(2/255)-1, else v/255. `gray` first folds RGB to
    PIL's "L" luma (ITU-R 601-2), the way manga-ocr reads every crop. */
export function chwFromRgba(
  data: Uint8Array,
  size: number,
  normalize: boolean,
  gray = false,
): Float32Array {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  const k = normalize ? 2 / 255 : 1 / 255;
  const bias = normalize ? -1 : 0;
  for (let p = 0; p < plane; p++) {
    const r = data[p * 4]!, g = data[p * 4 + 1]!, b = data[p * 4 + 2]!;
    if (gray) {
      const l = ((r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16) * k + bias;
      out[p] = l;
      out[plane + p] = l;
      out[2 * plane + p] = l;
    } else {
      out[p] = r * k + bias;
      out[plane + p] = g * k + bias;
      out[2 * plane + p] = b * k + bias;
    }
  }
  return out;
}

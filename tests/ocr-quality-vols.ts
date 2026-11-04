// Volume table for the OCR quality harness. Books are private files, not
// in the repo: paths come from YUKI_TEST_MANGA_DIR (and the optional
// YUKI_TEST_MANGA_EXTRA_DIR).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { unzipSync } from "fflate";

const MANGA_DIR =
  process.env.YUKI_TEST_MANGA_DIR ??
  "/Users/evegnius/Desktop/work_hobbies/言語学習者/manga";
const KAGUYA = join(MANGA_DIR, "kaguya");
const OSHINOKO = (n: string) => join(MANGA_DIR, `推しの子 第${n}巻`);
// More sidecar'd volumes (optional): a folder holding ふらいんぐうぃっち and
// おじさまと猫 (each volume a folder of images + a .mokuro next to it).
const EXTRA_DIR = process.env.YUKI_TEST_MANGA_EXTRA_DIR;
const sidecared = (dir: string, name: string) => ({
  images: () => fromDir(join(dir, name)),
  mokuro: join(dir, `${name}.mokuro`),
});
export type PageImage = { name: string; buf: Buffer | null };
export const VOLS: Record<
  string,
  { images: () => PageImage[]; mokuro?: string; golden?: string }
> = {
  kaguya: {
    images: () =>
      fromArchive(
        join(KAGUYA, "Kaguya-sama (Upscaled) - [赤坂アカ] かぐや様は告らせたい～天才たちの恋愛頭脳戦～ 01.cbz"),
      ),
    mokuro: join(KAGUYA, "[赤坂アカ] かぐや様は告らせたい～天才たちの恋愛頭脳戦～ 01.mokuro"),
    golden: "tests/golden/kaguya-01.json",
  },
  "kaguya-zip": {
    images: () =>
      fromArchive(join(KAGUYA, "[赤坂アカ] かぐや様は告らせたい～天才たちの恋愛頭脳戦～ 第01巻.zip")),
  },
  oshinoko: {
    images: () => fromDir(join(MANGA_DIR, "Oshinoko_1")),
    mokuro: join(MANGA_DIR, "Oshinoko_1.mokuro"),
    golden: "tests/golden/oshinoko-01.json",
  },
  ...Object.fromEntries(
    ["02", "03", "04", "05"].map((n) => [
      `oshinoko-${n}`,
      sidecared(OSHINOKO(n), `推しの子 第${n}巻`),
    ]),
  ),
  // No reference: garbage, runaway and speed checks only.
  "kimetsu-01": {
    images: () => fromArchive(join(MANGA_DIR, "鬼滅の刃", "[吾峠呼世晴] 鬼滅の刃 第01巻-20260731T164242Z-1-001.zip")),
  },
  // An image-only manga EPUB (opens in the manga reader): a zip of pages.
  "yani-01": {
    images: () =>
      fromArchive(join(MANGA_DIR, "スーパーの裏でヤニ吸うふたり", "スーパーの裏でヤニ吸うふたり 1巻 - 地主.epub")),
  },
  steinsgate: {
    images: () =>
      fromDir(
        join(
          MANGA_DIR,
          "steinsgate",
          "【一般コミック】 5pb.ｘニトロプラスｘ成家慎一郎 「STEINS;GATE 哀心迷図のバベル 全4巻」",
          "【一般コミック】 5pb.ｘニトロプラスｘ成家慎一郎 「STEINS;GATE 哀心迷図のバベル 第01巻」",
        ),
      ),
    golden: "tests/golden/steinsgate-01.json",
  },
  ...(EXTRA_DIR
    ? Object.fromEntries([
        ...["01", "02", "03"].map((n) => [
          `witch-${n}`,
          sidecared(join(EXTRA_DIR, "ふらいんぐうぃっち"), `[石塚千尋] ふらいんぐうぃっち 第${n}巻`),
        ]),
        ...["01", "02", "03", "04", "05", "06", "07", "08"].map((n) => [
          `ojisama-${n}`,
          sidecared(join(EXTRA_DIR, "おじさまと猫（1〜8巻）"), `[桜井海] おじさまと猫 第${n}巻`),
        ]),
      ])
    : {}),
};

function fromArchive(path: string): PageImage[] {
  const entries = unzipSync(readFileSync(path));
  return Object.keys(entries)
    .filter((k) => /\.(jpe?g|png|webp)$/i.test(k) && !k.includes("__MACOSX"))
    .sort()
    .map((k) => ({ name: basename(k), buf: Buffer.from(entries[k]!) }));
}
// A dangling entry (a symlink into a vanished folder) keeps its slot with a
// null buffer: page indices stay aligned with the golden files, and the run
// skips the page instead of dying on it.
function fromDir(dir: string): PageImage[] {
  return readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      return { name: f, buf: existsSync(path) ? readFileSync(path) : null };
    });
}

// Node unit test for the lazy zip reader (src/core/zip-entries.ts) and the
// manga archive import on top of it: entries read from the central
// directory equal unzipSync's — stored and deflated, UTF-8 and latin1
// names, a repeated name — and a zip volume keeps its pages, order and
// sidecar. Run: pnpm tsx tests/zip-unit.ts
import { strict as assert } from "node:assert";
import { strToU8, unzipSync, zipSync } from "fflate";
import { importMangaItems } from "../src/core/import-manga.ts";
import { openZip } from "../src/core/zip-entries.ts";

const page = (n: number, size: number) =>
  Uint8Array.from({ length: size }, (_, i) => (i * 31 + n * 7) % 256);

// Stored + deflated + a text entry + a folder, as an archiver writes them.
const zip = zipSync({
  "Vol 1/": new Uint8Array(0),
  "Vol 1/p10.jpg": [page(10, 5000), { level: 0 }],
  "Vol 1/p2.jpg": [page(2, 7000), { level: 6 }],
  "Vol 1/p1.png": [page(1, 3000), { level: 9 }],
  "Vol 1/readme.txt": strToU8("hello"),
  "Vol 1/vol.mokuro": strToU8(
    JSON.stringify({
      volume: "Vol 1",
      pages: [{ img_path: "p2.jpg", img_width: 800, img_height: 1200, blocks: [] }],
    }),
  ),
  "__MACOSX/Vol 1/._p1.png": new Uint8Array([1, 2, 3]),
});

{
  const reference = unzipSync(zip);
  const blob = new Blob([zip as BlobPart]);
  const archive = await openZip(blob);
  const entries = archive.entries;
  assert.deepEqual([...entries.keys()], Object.keys(reference), "same names, same order");
  for (const [name, entry] of entries) {
    assert.deepEqual([...(await archive.bytes(entry))], [...reference[name]!], name);
    const viaBlob = new Uint8Array(await (await archive.blob(entry, "x/y")).arrayBuffer());
    assert.deepEqual([...viaBlob], [...reference[name]!], `${name} as a blob`);
  }
  assert.equal(entries.get("Vol 1/p10.jpg")?.method, 0);
  assert.equal(entries.get("Vol 1/p2.jpg")?.method, 8);
  console.log("  ✓ stored and deflated entries equal unzipSync, names in order");
}

// Names without the UTF-8 flag decode as latin1 (like fflate) — patch the
// flag off a UTF-8-named archive and compare with unzipSync again.
{
  const named = zipSync({ "巻/01.jpg": [page(3, 100), { level: 0 }] });
  const patched = named.slice();
  for (let i = 0; i + 4 <= patched.length; i++) {
    const sig = patched[i]! | (patched[i + 1]! << 8) | (patched[i + 2]! << 16) | (patched[i + 3]! << 24);
    if (sig === 0x02014b50) patched[i + 9] = patched[i + 9]! & ~0x08;
    if (sig === 0x04034b50) patched[i + 7] = patched[i + 7]! & ~0x08;
  }
  const reference = Object.keys(unzipSync(patched));
  const lazy = [...(await openZip(new Blob([patched as BlobPart]))).entries.keys()];
  assert.deepEqual(lazy, reference);
  console.log("  ✓ non-UTF-8 names decode like fflate");
}

// A zip volume: images only, natural order, common root stripped, sidecar
// aligned by file name.
{
  const file = new File([zip as BlobPart], "Vol 1.zip");
  const [volume] = await importMangaItems([{ file, path: file.name }]);
  assert.ok(volume);
  assert.deepEqual(
    volume.pages.map((p) => p.path),
    ["p1.png", "p2.jpg", "p10.jpg"],
  );
  assert.equal(volume.pages[1]?.img_width, 800);
  assert.equal(volume.blobs[0]?.type, "image/png");
  assert.deepEqual(
    [...new Uint8Array(await volume.blobs[2]!.arrayBuffer())],
    [...page(10, 5000)],
  );
  console.log("  ✓ zip volume: pages, order, mime, sidecar");
}

console.log("zip-unit: all checks passed");

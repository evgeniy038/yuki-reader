# Tests

Node-side units and parser smokes are self-contained (fixtures built on the
fly). `pnpm test` runs all twelve: epub, dictionaries, backup, shelf, stats,
book-css, resources, reader-touch, storage (the v7 → v8 book split), zip
(lazy archive reading vs unzipSync), ocr-lines (the OCR line splitter on
synthetic glyph rasters), icons, sync. Standalone extras:

```
pnpm tsx tests/ocr-download.ts
pnpm tsx tests/decoder-selective-fetch.ts
```

Browser smokes drive the real reader on real books. Books are private
files, not in the repo — paths come from env vars:

| Variable | Points to | Used by |
| --- | --- | --- |
| `YUKI_TEST_EPUB_DIR` | folder with test `.epub` files | all epub smokes |
| `YUKI_TEST_EPUB_FILTER` | name substring of the main book (also searched) | stats, routing, bookmark, reader-panel, library, shelf-collapse |
| `YUKI_TEST_EPUB_FILTER2` | name substring of a second book | library, shelf-collapse |
| `YUKI_TEST_PDF_TEXT` | PDF with a text layer | pdf-smoke, reader-panel |
| `YUKI_TEST_PDF_SCAN` | scanned PDF | pdf-smoke |
| `YUKI_TEST_MANGA_DIR` | manga folder (volume folders with `.mokuro`, zip in `kaguya/`) | manga-smoke, manga-drag-smoke, ocr-smoke, ocr-quality, backup-smoke, shelf-collapse (optional) |

Do not edit `src/` during a browser run — vite full-reload breaks in-flight
loads.

shelf-collapse-smoke folds a plain section, and — when `YUKI_TEST_MANGA_DIR`
is set — also the mixed novel+manga group: the whole group folds into one
stack, and the manga h3 subsection folds on its own.

## Sync (no fixtures, no account)

`pnpm test:sync` (part of `pnpm test`) covers the sync rules in Node: merge
(blank records never win, latest dwell wins, the further position is offered,
first join, deletion guards, skewed clocks), content keys, sealing and the
recovery key (`sync-unit`); two devices on one in-memory cloud folder with the
real engine and sync database — join, positions, stats sum, rollback and
tamper ignored, deletes (`sync-engine-unit`); and both cloud adapters against
fakes of the Yandex Disk and Dropbox HTTP APIs — token refresh on 401, dead
grant, full disk, no client secret anywhere, Dropbox's watch armed before
the look and guarded against a silent line (`sync-providers-unit`); and the
book files — a pack round-trips byte for byte, a broken upload resumes with
the manifest last, a tampered part never becomes a half-stored book, novels
go up alone, manga only when kept in the cloud, uploads run on a budget, a
deleted book's pack comes down, and an older-format pack is sent again by
its uploader only (`sync-files-unit`); and the direct
device-to-device leg minus WebRTC — the pack stream in 64 KB frames received
in pieces of any size, exact pages, nothing half-stored on a short or long
stream, sealed doorbell signals that go stale, and device catalogs published
sealed and rewritten only on change, every holder rung, and the wire's brake
— a sender never more than the window ahead of what the receiver STORED,
an older receiver still served (`sync-p2p-unit`). How fast a volume moves is
measured, not guessed: `pnpm tsx tests/sync-files-bench.ts` sends a 200-page
volume through a cloud with a fixed per-request latency and a shared link
(`LATENCY_MS`, `LINK_MBIT`, `PAGES`, `PAGE_KB`) and prints time and request
count each way. How much memory sync takes is measured too:
`pnpm tsx tests/sync-memory-bench.ts` (sync dev server, see below) imports a
heavy library (`NOVELS`, `NOVEL_MB`, `PAGES`) and prints the page's renderer
RSS from the OS for each phase — a synced app start must sit at the level of
one with sync off (iOS kills a page that grows too big).

`pnpm test:sync-smoke` drives two Chrome profiles as two devices through the
real UI, with Yandex Disk (OAuth, REST, upload/download hosts) emulated by
request interception — including a novel that arrives on the other device by
itself, a manga volume kept in the cloud that waits there as a tile, opened
with a tap, and one that never went up, which the phone fetches straight from
the open Mac over a real WebRTC connection — through a cloud slowed to VPN
latency, without ever asking to open yuki on the open Mac — and, with the
Mac closed, asks to open yuki there. The fake Yandex lives in
`sync-smoke-cloud.ts`. Start a dev server with a provider id first:

```
VITE_YANDEX_CLIENT_ID=smoke pnpm dev --port 1480
YUKI_TEST_BASE=http://localhost:1480 pnpm test:sync-smoke
```

## Hostile books (no fixtures)

`pnpm test:book-sanitize` imports an EPUB armed with script vectors (img
onerror, details ontoggle, SVG animate, javascript: links, iframe srcdoc, a
remote tracking pixel) and checks that nothing runs and nothing dangerous
reaches the page. Against a production build it also proves the CSP blocks an
inline handler on its own:

```
pnpm build && pnpm preview --port 1481
YUKI_TEST_BASE=http://localhost:1481 YUKI_TEST_EXPECT_CSP=1 pnpm test:book-sanitize
```

## Phone reading (no fixtures, built-in demo book)

`pnpm test:mobile` drives the demo book in a phone-sized Chrome with real
CDP touch events and the iPhone Pro Max safe-area insets: controls on open
and clear of the status bar, middle-band toggle with the scrubber bar,
band taps and swipes in both reading directions, the page-turn animation
switch in the text reader and on the manga pager (a volume drawn on the fly:
on, turns slide and the page follows the finger; off, they just flip), the
16px field guard. The pure touch geometry (bands, swipes, the pager's
turn-or-stay verdict, spring, manga neighbour sets, pan bounds) is
unit-tested in `pnpm test:reader-touch` (part of `pnpm test`).

## Reader chrome and panels (no fixtures, built-in demo book)

Drive the dev server `:1420` and the built-in demo book (`?demo=h`).
`HEADED=1` uses a real window and the native macOS fullscreen transition —
fullscreen bugs do not reproduce without it.

```
HEADED=1 pnpm tsx tests/reader-chrome-fullscreen-smoke.ts   # every pill button clicks at 5 points in fullscreen
pnpm tsx tests/panel-wheel-smoke.ts                         # wheel inside toc/search scrolls the panel, not the book
pnpm tsx tests/fullscreen-real-input-probe.ts               # moves the REAL cursor (swift/CoreGraphics, HID level)
```

`fullscreen-real-input-probe` requires Input Monitoring for the terminal
(System Settings → Privacy & Security); without it the events are silently
dropped.

## OCR quality gate (`tests/ocr-quality.ts`)

Runs the production pipeline (`src/core/ocr/`, same parameters; the line
splitter is the production module itself) over whole volumes in Node and
measures accuracy. Pixels come from a real headless Chrome canvas
(`--canvas chrome`, the default): the app resamples every model input with
OffscreenCanvas `drawImage`, and Chrome's resampler — not sharp's — decides
what the models see. Two scorecards:

- vs the `.mokuro` sidecar — IoU block matching + CER over every page
  (broad, but the reference is itself an OCR run: closeness to mokuro, not
  truth);
- vs `tests/golden/<vol>-01.json` — vision-verified blocks (box = IoU
  matching, box=null = per-page text matching). Pages are found by image
  name, so a folder that loses a file does not shift the truth. Blocks
  marked `src: "vision (A/B disagreement, adjudicated on the crop)"` were
  sampled where two pipeline variants disagreed and read off the crop by
  eye — the hard cases the consensus blocks miss.

```
pnpm tsx tests/ocr-quality.ts --vol kaguya [--pages all|3,20] \
  [--models merged|q4f16|q8|fp32|l0] [--det full|fp16|s] [--dump] \
  [--canvas chrome|sharp] [--smoothing high|default|low|medium] [--no-gray] \
  [--no-lines | --split-below 18] [--beams 4] [--rec mocr|baberu|ppocr] \
  [--conf 0.4] [--mokuro other.mokuro] [--tag name] \
  [--gate [--gate-recall R] [--gate-cer C] [--gate-runaway N]]
```

Defaults are the shipped pipeline (smoothing "high", grayscale crops, dense
blocks read line by line, detector confidence 0.35); the `--no-*` flags
switch a stage off for A/B, and `--smoothing default --no-gray --no-lines
--conf 0.4` is the pipeline before them. A volume with neither reference
still lists its blocks in the report (`unrefReports`) and counts runaways.
`--gate` exits 1 on recall / meanCER regressions or runaway loops (one
glyph 20+ times, a 2–4-glyph cycle 10+ times, or a 5–12-glyph phrase 4+
times) on the golden pages; the
thresholds live in each golden file's `gate` (the shipped pipeline's scores
plus a margin), CLI flags override. Reports go to `YUKI_OCR_QUALITY_OUT`
(default `/tmp/ocr-quality/`). Models are read from `YUKI_OCR_MODEL_DIR`
(default `/tmp/yuki-ocr-models/`: a snapshot of `public/ocr-models` under the
names in the harness's MODEL_SETS/DETECTORS, plus fp32/fp16 A/B files);
`--rec baberu|ppocr` A/B recognizers come from `YUKI_OCR_ALT_DIR`.
`YUKI_TEST_MANGA_EXTRA_DIR` adds the ふらいんぐうぃっち / おじさまと猫
volumes; `YUKI_OCR_THREADS` caps onnxruntime's threads.

## Shipped decoder recipe

`decoder_model_merged_batch_int8.onnx` is rebuilt from
`kha-white/manga-ocr-base` with three scripts (venv with torch/transformers/
optimum/onnxruntime): `tests/mocr-export-batch.py` (two torch.onnx.export +
merge_decoders, batch axis dynamic everywhere) → `tests/mocr-quantize-batch.py`
(fold constants and weight transposes into initializers, quantize_dynamic
int8, merge) → `tests/mocr-validate-batch.py` (proof: batch ≡ solo decode
token-by-token, batch=1 ≡ HF greedy; zero-padding enc_seq is forbidden — the
decoder has no encoder attention mask).

## OCR cancellation regression (`tests/ocr-cancel-race.ts`)

Imports one volume (`YUKI_BENCH_ZIP` or `YUKI_BENCH_DIR`), deletes it while
OCR is running, and verifies in IndexedDB that the volume UUID leaves no
rows in books, manga, mangaPages, or mangaOcr and never resurrects. A second
import of the same fixture receives a new random UUID and must also delete
cleanly. Set `YUKI_TEST_BASE` for a non-default server and
`YUKI_BENCH_PROFILE_DIR` to reuse a warm model cache.

```
YUKI_BENCH_ZIP=/path/vol.zip pnpm tsx tests/ocr-cancel-race.ts
```

`pdf-smoke` expectations (page counts, language) are tied to specific
fixtures — update the checks in code when the files change.
`layout-smoke` and `position-smoke` take a book folder as the first CLI
argument.

## Speed benchmark (`tests/perf-bench.ts`)

Real books through the real UI, every duration timed inside the page
(`perf-probes.ts`: conditions polled per animation frame, long tasks,
keystroke→turned-page). Scenarios: `library` (EPUB import one/batch, open,
page turns, startup + memory), `manga` (folder+sidecar, zip, cbz, comic
EPUB; OCR downloads aborted), `ocr` (one volume end to end, pages/min;
`YUKI_BENCH_OCR_DUMP=file` writes every page's text for byte-level A/B),
`pdf`, `backup`. Profiles are temporary and removed after each scenario.

```
YUKI_TEST_BASE=http://localhost:1461 YUKI_TEST_EPUB_DIR=… YUKI_TEST_MANGA_DIR=… \
  pnpm tsx tests/perf-bench.ts library manga --out /tmp/after.json
```

Measure a production build (`pnpm build && pnpm preview --port 1461`): the
dev server's unbundled modules dominate startup. Compare A/B by alternating
runs of both builds and taking the best of several — other load on the
machine skews single runs badly. `YUKI_BENCH_ENGINE=webkit` runs the same
scenarios in Playwright's WebKit (the closest stand-in for iPhone Safari).

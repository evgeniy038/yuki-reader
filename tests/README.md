# Tests

Node-side units and parser smokes are self-contained (fixtures built on the
fly). `pnpm test` runs all ten: epub, dictionaries, backup, shelf, stats,
book-css, resources, reader-touch, storage (the v7 → v8 book split), zip
(lazy archive reading vs unzipSync). Standalone extras:

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

## Phone reading (no fixtures, built-in demo book)

`pnpm test:mobile` drives the demo book in a phone-sized Chrome with real
CDP touch events and the iPhone Pro Max safe-area insets: controls on open
and clear of the status bar, middle-band toggle with the scrubber bar,
band taps and swipes in both reading directions, the 16px field guard.
The pure touch geometry (bands, swipes, spring, manga neighbour sets, pan
bounds) is unit-tested in `pnpm test:reader-touch` (part of `pnpm test`).

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

Runs the production pipeline (`src/core/ocr/pipeline.ts`, same parameters,
`sharp` instead of canvas) over whole volumes in Node and measures accuracy:

- against the `.mokuro` reference (IoU block matching + CER), and/or
- against `tests/golden/<vol>-01.json` — vision-verified blocks (box =
  IoU matching, box=null = per-page text matching).

```
pnpm tsx tests/ocr-quality.ts --vol kaguya [--pages all|3,20] \
  [--models q8|merged|q4f16|fp32|l0] [--det s|full|fp16] [--dump] \
  [--gate [--gate-recall 0.85] [--gate-cer 0.10] [--gate-runaway 0]]
```

`--gate` exits 1 on recall / meanCER regressions or runaway outliers on the
golden pages. Reports go to `/tmp/ocr-quality/`. Models are read from
`/tmp/yuki-ocr-models/` (snapshot of production models + fp32/l0 for A/B;
`fp16` — webgpu detector, production default).

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

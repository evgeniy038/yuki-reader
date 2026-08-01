# yuki — domain context

A reader for Japanese novels and English books — a website.
This file is the project's shared language: how we name things in code, UI,
and conversation. Implementation details don't belong here — meanings only.

## Shell

Every screen is a real URL (react-router, HashRouter: the site is static —
the host serves only index.html, and hash routes make each page a real,
reloadable URL with no server rules): Library `/#/`, Statistics `/#/stats`,
Settings `/#/settings`, an open book `/#/read/:id`. F5 lands exactly back —
the current section and the open book derive from the location, not from
state; an unknown path redirects home.
The shell is one layer: a page on a gray backdrop, navigation a floating
**pill** at the bottom center (`nav-pill.tsx`): three sections (icon over
caption, wide buttons) with no gaps; the active one is marked by an
indicator slab that slides between buttons (a 150ms morph); radii follow the
ladder — the pill is `rounded-xl`, indicator and buttons one step down.
Surface steps separate states: hover sits one step BELOW the active slab
(`muted-surface` vs `hover-surface`) — the two must never merge. There is no
separate "Home" — the single entry/resume point is the **Library** (its
default "Last read" sort lifts the current book anyway). The reader doesn't
use the shell — it's fullscreen.

## Sections

Every page is composed from `page-shell.tsx` — children composition in the
shadcn spirit: `PageShell` (shared rhythm: max width, padding), `PageHeader`
— always a 32px row (`min-h-8`), with or without actions, so the content of
every page starts at the same offset from the card edge; `PageTitle`
(font-medium) on the left, `PageActions` on the right — only actions that
make sense in this section (sort and "Add book" for the Library — both
hidden on the empty shelf, where the empty state carries the add action);
filters go before the button. A section inside a page keeps its action in the section
header. Section subtitles share one `PageSectionTitle`. An empty section
shows an **empty state** — one pattern across pages: centered icon, title,
one line of description, and an accent action button.

- **Library** — the default section, the whole catalog: title with a counter,
  sort and "Add book" in the header, language sections. No search or filters
  by decision — minimalism wins. Import doesn't open the book: a batch lands
  at once, opening happens from the tile.
- **Statistics** — the reading-habit section (same width and rhythm as
  Settings): today's summary (characters, time, streak, totals), a half-year
  activity **heatmap** (cells stretch to the card width; intensity by active
  minutes per day — the only measure shared by EPUB characters and PDF
  pages), and the **daily goal** — a progress ring (ProgressRing) and two
  count modes: flat characters or **percent of a book** — the goal book is
  chosen by the user in a select with covers in the "8% of …" row (defaults
  to the current read; the choice is remembered), and the percent scales with
  that book's length (EPUB characters, PDF pages). Data is one record per
  local day: while the reader is open, the session accumulates reading and
  active time (heartbeat: app visible, last activity fresh). Characters/pages
  are credited per page: a page counts as read after 3 seconds on it (the
  same dwell that moves the bookmark), each once per session, so paging back
  never inflates or subtracts. A session under 10 seconds of active time is
  "peeked into a book": nothing reaches the journal. Every session reset is
  also attributed to the book: each book accumulates its own
  characters/pages and time, shown in its "Details" dialog (read, reading
  time, speed). **Reading speed** — characters per hour (pages per hour for
  PDF); counted from one minute of active time and lives in the day summary
  ("Speed today") and in the book card.
- **Settings** — a page of **group cards** (`settings-group.tsx`): a small
  title above the rounded card (title inset = the card's corner end), the
  card has no border — the lightest shadow lifts it; rows inside the card
  are separated by hairlines inset from both edges, the group action lives
  in the header row.
  Groups: **General** (interface language — English/Русский select),
  **Reading** (first a live **preview** — real text on the user's settings,
  日本語/English switch, Japanese renders vertically; the whole preview —
  the furigana/language header and the text — is a bordered inset pane
  inside the card (SettingsBlock), fixed height, no masks; no hairline after
  the pane — the pane itself is the boundary; then "label + control" rows of
  one height: font, size, line height, page margins) and
  **About yuki** — build version and changelog, collapsed at the very bottom
  of the page; the only source of entries is `CHANGELOG.md` (in English) —
  the group is built from it: a version is a one-liner with a short
  description, the full text expands on tap, bullet lead-ins ("Library: …")
  render as mini-headings (weight and color only, size unchanged).

## Design language

Accent — **primary blue** (gradient
oklch(69.1% 0.162 250.3) → oklch(60.5% 0.204 254.5): chroma grows with
depth, hue drifts slightly toward violet; the shadow set: an inner white
highlight, micro-shadows, a half-pixel text shadow, and an outline ring
oklch(64.6% 0.178 252.4) sitting between the gradient stops by lightness):
action buttons and accent controls (slider fill, engaged switch). Radii — a
token ladder, not point classes: card 16 (`rounded-card`) → inset pane 12
(`rounded-pane`) → controls 8/6; a nested surface is always one step smaller
than its parent.
Mutually exclusive options (reading font, etc.) use a **segmented control**:
gray track, the chosen segment lifts as a white card, no accent fill; the
card is ONE indicator (`use-sliding-indicator`) sliding between segments
with a 150ms transform animation. A discrete numeric value uses a
**stepper** (− value +), a continuous one a **slider** (`ui/slider.tsx`:
gray track, primary-gradient fill, white thumb), a binary one a **switch**
(`ui/switch.tsx`, macOS-style toggle). Interface font — Inter (Variable, 400
for body, 500 for headings; book text in the reader uses separate book
typefaces). Icons — Phosphor (`@phosphor-icons/react`), weight `bold` set
globally via `IconContext` in main.tsx, interface size 16 (`icon-nav`).
Floating surfaces (menus, popups, popovers) appear the same way: a short
fade + a light zoom from their origin; under reduced-motion all moving
animation is muted globally.

**One button** — `ui/button.tsx`; local button styles are banned, every
action goes through it (variants default/outline/secondary/ghost/destructive,
size sm is the default; `shape="round"` for icon buttons in pills). Default
is the primary itself: the blue gradient with its signature shadow set
(inner white highlight + micro-shadows + outline ring) and a half-pixel text
shadow.
Button feel: colors change in 125ms, press is scale 0.97 on a 389ms spring
(`--ease-press`/`--duration-press`, force press down to 0.94), solid
lightens slightly when pressed (`press-solid`). Loading doesn't gray the
button: the variant colors stay, the spinner pushes content apart via
margin-left; the only gray state is disabled. While the shelf loads from
storage, the loader `ui/dash-ring.tsx` (a dash ring with a morphing arc)
shows instead of the empty state.

## Shelf

**Shelf** — the display of all imported **books** inside sections. One book =
one tile (cover + title + author + reading state); a manga series collapses
into one tile too (see "Manga"). Book actions live in the tile's context
menu (right-click): "Open", "Details", "Rename", "Change cover", "Delete".

**Book** — an imported file plus metadata: title, author, cover, **format**
(epub | pdf | manga), **language**, date added, last-read date, progress.
Re-importing the same file is rejected — no duplicates on the shelf.

## Reading state

Derived from progress, not stored as a field:

- **new** — progress 0 (the tile stays silent);
- **reading** — 0 < progress < 100% (the tile shows whole percents: "7%");
- **finished** — progress ≥ 99.5% (the tile: "Read").

## Shelf sort

- **"Last read"** — the default: the later a book was opened (or added, if
  never opened), the higher it sits. Opening a book lifts it to the top.
- **"Title"**, **"Author"** — alphabetical.
- **"Date added"** — by import date.
- **"Progress"** — unfinished first.

The chosen order is remembered between launches.

## Book language

**Language** — Japanese or English, detected from content at import
(kana/kanji → Japanese, latin → English). It drives: the text reader's
writing mode (vertical/horizontal) and shelf grouping. When the shelf holds
books of both languages, it splits into sections: 日本語 — English.

## UI language

The **interface** language is a separate axis, unrelated to book language:
i18next (`src/lib/i18n/`), locales `en` (source of keys, the `Messages` type)
and `ru` (typed by it — a missed or extra key is caught by tsc). Plurals —
i18next JSON v4 (`_one/_few/_many/_other`), numbers inside strings via
`{{count, number}}` (active-locale Intl). Default — English; the detector
checks localStorage `yuki-lang`, then the browser language, fallback `en`.
The switch is the first settings group, "General"; `<html lang>` syncs on
change. All UI labels go through `t()`; number, date and duration formatting
through `src/lib/format.ts` (Intl per active locale).

## Format and page (pdf)

The book's **format** — epub or pdf — defines how it is read. EPUB reflows
into a stream and is cut into pages by the reader — one centered column on a
narrow screen, a two-page **spread** on a wide one, like the PDF view (the
Japanese stream stays vertical, one page at a time); PDF is read **as is**:
document page = reader page, the author's layout (columns, formulas, scans)
is untouched. On a wide screen a PDF shows as a **spread** — two pages side
by side, like a physical book (the cover alone, then pairs: even left, odd
right); on narrow screens and phones — one page. So PDF has its own length
measures: **pages** instead of "chapters" and "characters". PDF progress is
a page number, not characters. Text on a PDF page stays selectable, but a
page without a text layer (a scan) has nothing to select — that's normal.

## Manga

Manga is the third format: a **series** of **volumes**, each volume a shelved
book (`format: "manga"`, language ja, measured in pages). Import accepts
whatever scans come in — a zip/cbz archive, a folder of images, an optional
`.mokuro` OCR sidecar next to them (in or beside the archive): only image
entries are read, anything else (shortcuts, readme junk, `__MACOSX`) is
skipped. Volumes group into a series by the name derived from the file or
folder (`[Author] Title 第01巻`, `Name_v05`, `Name_3` — author brackets,
volume markers, fullwidth digits, drive-export suffixes all fold); that is
deliberately NOT the sidecar's uuid — real files all carry the OCR tool's
default title, so uuid grouping scatters volumes across one-episode
"series". The shelf shows one tile per series (the earliest volume's cover,
volume count, mean progress); the tile opens the **series page**
(`#/manga/<key>`) — the volume grid with per-volume covers, numbers, context
actions (open, rename, move to another series, delete) and drag reorder.
"Add volume" there imports straight into that series, whatever the files
say.

The manga reader mirrors the PDF one, but right-to-left: cover alone, then
spreads with the EARLIER page on the right; left means forward (slim
edge-click strips, arrow keys). The wheel zooms toward the cursor and a drag
pans while zoomed in; a page turn resets both. Pages come from the pages
store as object URLs in a small window around the current page (a volume
never sits in memory whole).
With a sidecar, its text boxes overlay the scan in source-image pixels,
scaled with the page: hidden until hovered, click pins a box open (and makes
the lines selectable) without turning the page; smaller boxes stack above
larger ones. Exiting the reader returns to the series page. In storage a
volume's page scans live in their own store keyed `bookId/index` — a
progress save never rewrites megabytes of images.

Scans WITHOUT a sidecar get OCR'd by the app itself (`src/core/ocr/`): the
ogkalu comic-text-and-bubble-detector (always the FULL build — measured 2x
better CER than the 11MB "-s" variant; the exact weights follow the
execution provider, see below) and manga-ocr (224²
crops, greedy char-WordPiece decode). The decoder is an in-house KV-cache
merged export (BERT decoder + past key values, `use_cache_branch` — optimum's
CLI refuses to build past for bert, so it is two manual `torch.onnx.export`
graphs fused by `merge_decoders`, then int8: Constants and weight Transposes
must be folded into initializers first or quantize_dynamic sees nothing).
Every axis is batched, so one run advances a whole 4-crop batch in lockstep
(rows all start at START together — always rectangular; validated
token-exact vs solo decode). Merged decode is ~2.6x faster than full-prefix
at identical CER (the full-prefix fallback is gone — the merged file is the
only shipped decoder); the file (~30MB) ships same-origin from
`public/ocr-models/` (Hugging Face has no
merged variant, and GitHub release assets send no CORS headers — measured —
so a browser cannot fetch them at all). The recognition encoder picks its
weights by execution provider (`detectPreferredEp`, cached in localStorage
`yuki-ocr-ep`): wasm → int8 (fastest CPU GEMM), WebGPU → q4f16 (MatMulNBits
is the only quantization with a native GPU kernel — measured ~12x faster
than int8-on-wasm per block, while int8/fp16 on WebGPU are SLOWER than wasm,
gpuweb#5292). A WebGPU session-build failure falls back to wasm (the q4f16
MatMulNBits ops run on CPU too). The detector follows the same EP split:
WebGPU → an in-house fp16 build (~85MB, converted in-house from ogkalu's
fp32 export, shipped same-origin) measured ~68ms/page — 19x faster than the
43MB int8 HF build on wasm (~1.3s/page) — at the same boxes (int8 weights on
WebGPU instead are 2.7x SLOWER than on wasm: their kernels fall back to
CPU). The decoder always stays on wasm.
All sessions and tensors inside a worker come from ONE onnxruntime-web build
(`src/core/ocr/ort-runtime.ts` facade) — mixing Tensor objects across the
wasm/webgpu builds is unsupported. Sessions are created strictly
sequentially (ORT rejects concurrent creates outright) and inference runs
are strictly serialized per worker — measured: two sessions running
concurrently in one runtime instance crash OrtRun ("__next_prime
overflow"), and the renderer never recovers. The
execution topology adapts to the host: when cross-origin isolated (the dev
server and any host sending COOP/COEP — `public/_headers` covers CF
Pages/Netlify; GitHub Pages can't), ONE worker runs with half the cores as
wasm threads — measured optimum on an M3 Pro for the wasm EP: encoder
~148ms/block vs ~830 single-threaded, ~16.5 pages/min vs ~9 (extra workers
only fight over the memory bus; threads past the P-core count stall on
E-core barriers). Without SharedArrayBuffer the runtime clamps to one
thread, and a small pool of single-threaded workers (3 on 8+ cores, else 2)
is the fallback. The dev
server must send COEP on the ORT glue itself — the threaded runtime spawns
its pthread workers from that URL and worker scripts are COEP-checked as
frame resources, else session init hangs with no error. The main thread is
the scheduler: it owns the FIFO queue (hovered blocks jump it, everything
else waits its turn), downloads the model files once — big ones over
parallel HTTP ranges, then forever from IndexedDB — and hands each worker
its own copy of the bytes (~130MB per worker). Per-page results land in
`mangaOcr` (keyed `bookId/pageIndex`, with an engine version that forces a
re-run when the pipeline changes). Every sidecar-less volume goes through
the same pipeline: DETECT writes skeleton blocks for every page (final
boxes, empty lines — ~10x cheaper), then the recognition MARCH works
through the remaining pages in order at the back of the queue whenever a
worker is free, so a volume finishes on its own in a few minutes (~60-70
pages/min measured on an M3 Pro with WebGPU; blocks go through the encoder
AND the int8 decoder in 4-crop lockstep batches — the shipped merged
decoder has a dynamic batch dim, validated token-exact vs solo decode;
decoder batching is speed-neutral because the per-step cost is GEMM-bound,
not run overhead — but it collapses the whole decode to one code path; an
fp16 WebGPU decoder build was measured and rejected: 2-3x slower per step
than int8 on wasm, the per-step GEMMs are too skinny for GPU dispatch)
without ever blocking the reader. Hovering a skeleton block recognizes just that crop
ahead of everything (the box shows an ellipsis only until the text lands,
sub-second on a free worker). The sidecar always wins. Progress is tracked
per volume from STORAGE, never from queue length (`trackMangaOcr` counts
sidecar-less pages vs `loadMangaOcrFlags`): the queue panel at the bottom
right (`ocr-queue-panel.tsx`) lists every unfinished volume — the first one
featured with cover and progress bar, the queue below, finished volumes
leaving with a check — and folds into a summary pill with a blur collapse
(expanded on the shelf, collapsed over the reader; hidden when idle). A
volume stays GATED on the series page (frosted cover, spinner, no entry)
until its detect stage completes; recognition runs while you read. After a
reload `resumeMangaOcr` re-registers every unfinished volume from storage
and the march continues where it stopped. Deleting a volume cancels its
queue and cascades the OCR store. `?ocrPool=N`, `?ocrThreads=M` and `?ocrDebug=1` (per-stage
page timings) exist for probes. The greedy decoder carries a runaway guard:
on non-text texture the model loops (300 dots, ははは…, 第条第条… — fp32
weights loop on the same pages, so it is structural), and the loop is cut at
15 same tokens or a 2..4-token cycle of 12+, keeping 3 tokens/one cycle.

Accuracy is measured, not guessed: `tests/ocr-quality.ts` reruns the shipped
pipeline in Node over whole volumes and scores it against `.mokuro`
references and vision-verified golden files (`tests/golden/`), with a
`--gate` mode (recall/CER/runaway thresholds, exit 1). Full-volume A/B on
kaguya-01: fp32 recognition buys ~2.5pp CER for 4× the bytes (rejected);
the full 43MB detector halves CER vs the shipped 11MB one (0.077 vs 0.157)
at ~2× extra false-positive blocks — and feeding mokuro's boxes to our
encoder fixes «英検»-class misreads, i.e. box quality, not the recognizer,
is the bottleneck. Line-level (mokuro-style per-line) OCR is the known next
lever for dense small text (profile pages, colophons).


## Reading position

Opening a book resumes where you stopped: the position is stored as 0..1
progress and restored exactly — into a character anchor for EPUB, into a
page number for PDF. The bookmark moves only by a 3-second **dwell** on a
page: fast paging in either direction doesn't shift the restore point, and
leaving the reader doesn't save the position.

## Reading theme

**Theme** — the page background: Light, Sepia, Dark. Switched in Settings
(the "Theme" row) and right from the reader (the gear popover — that's why
both formats have it). Applies to both formats: in EPUB the stream's
background and text repaint; a PDF page is a print image, so it's tinted by
a filter (dark = inversion). The theme is remembered between launches.

## Contents and search (reader panels)

The reader has two slide-in panels at the left edge (buttons in the reader
chrome, Esc or an outside click closes): **table of contents** and **in-book
search**. The TOC lists chapters with the current one marked: from NCX/nav
for EPUB (empty entries dropped; without them, a fallback derivation from
chapter starts), from document bookmarks for PDF (no bookmarks — no button).
An entry's position is a page number for PDF and a percent of the book for
EPUB: stream pages recompute at every zoom, so the stable measure there is
the share. Search runs over the whole book text and shows up to 50 matches
with context and the same position. Tapping a chapter or a match jumps
exactly to it and closes the panel — keep reading.

## Distribution

Yuki is a static website, not an app. Reader data (shelf, progress, stats)
lives in the browser's IndexedDB and survives deploys — a site update never
touches the library. After the first visit the site is fully cached by a
service worker and works offline. A new version doesn't interrupt reading:
the updated worker waits in the background, and the quiet "New version
ready" card offers to reload now — otherwise the next natural visit applies
it. A release is a git tag `v*`: Actions builds the site (the base path is
derived automatically: root for a user-site, `/<repo>/` for a project-site)
and publishes to Pages. One changelog — `CHANGELOG.md` at the root; the
"About yuki" group in Settings is built from it too.

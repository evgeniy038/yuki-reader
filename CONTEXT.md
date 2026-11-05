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
header. Section subtitles are plain `h2` (`text-sm text-default`) with
subsections one step down (`h3`, `text-xs text-muted-content`) — no dedicated
component. An empty section shows an **empty state** — one pattern across
pages: centered icon, title, one line of description, and an accent action
button.

- **Library** — the default section, the whole catalog: title with a counter,
  sort and "Add book" in the header, language sections. No search or filters
  by decision — minimalism wins. Import doesn't open the book: a batch lands
  at once, opening happens from the tile. A book can be **pinned** (the
  bookmark ribbon on the cover's top-right corner, or the context menu):
  pinned books lead their shelf section and carry the gradient ribbon. Each
  language section collapses into a **folded stack** of covers (the section
  header carries the caret; a folded section of mixed novels and manga folds
  as one, manga subsections fold on their own), and sections reorder by
  dragging the header — the order is remembered.
- **Statistics** — the reading-habit section (same width and rhythm as
  Settings): today's summary (characters, time, streak, totals), then the
  **charts** card — minutes per day (bars, two-week window), **reading
  speed** over the same window (characters per hour; pages per hour for
  PDF) and the current book's pace (volume read and days left at that
  speed) — and below it the half-year activity **heatmap** (cells stretch
  to the card width; intensity by active
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
  one height: font, size, line height, page margins),
  **Dictionaries** — the Yomitan-dictionary library: install from the
  catalog or import a ZIP, reorder and toggle installed dictionaries
  (currently parked: lookup and installation are disabled while package
  delivery is fixed — the group shows, the actions sleep), **Progress** —
  the backup group: everything (books, reading progress, stats, settings,
  dictionaries) exports as one ZIP and restores back — from a Yuki backup
  or a ttsu one — with honest per-item progress and a working cancel;
  and **About yuki** — build version and changelog, collapsed at the very bottom
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
typefaces). Icons — yuki's own set (`ui/icons.tsx`) on a 16-unit grid,
interface size 16 (`icon-nav`), in two weights of one family: at rest an
**outline** (1.5px round strokes), and the **filled** weight (solid bodies
with radius 1–1.75, details knocked out with a 1.5px cut) only for what is
active — the current section in the dock, an open reader panel or the
settings popover, a pinned book, a finished task. One color
(`currentColor`) — hover and disabled come from the parent's text color.
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
In storage a book is two halves: the **shelf record** (the metadata above —
a few KB, read at startup, the only thing a progress save rewrites) and its
**content** (chapters, images, PDF bytes — read when the book opens; a
couple of recent books stay in memory). The shelf never holds the whole
library's bytes. Imports (EPUB parsing, manga unpacking) run in an import
worker, never on the UI thread; archives are read lazily from their zip
directory — page by page, never the whole file in memory.

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
crops, greedy char-WordPiece decode). Every model input is resampled with
`imageSmoothingQuality: "high"` — Chrome's default drawImage downscale
aliases (white-noise test: std 40.9 vs 14.1) — and recognition crops are
folded to grayscale, the only colour space manga-ocr was trained on.
Detector boxes are kept from confidence 0.35: on the antialiased input
that misses fewer real blocks than 0.4 did on the aliased one and still
finds fewer false ones (below 0.35 screentone strips and duplicate boxes
take over). A
**dense** block is read **line by line** (`lines.ts`): when the whole
padded block squeezed to 224² would leave a glyph under 18px (long
columns, paragraphs, a long caption line), its columns or rows are found
from the ink profile (orientation by line spacing — wide bubbles of truly
long columns are columns, a wide title with ruby above is not; rows only
in blocks that are not tall; ruby is left out of its line's crop, since a
lone column hands its furigana over as text; narrow edge bands that are
light or short — ruby beside the first line, bubble-outline fragments —
are set aside, while a short line of full-size glyphs (でも opening a
bubble, ね closing it) is text and stays; ink the
lines miss beyond that sends the block back to a whole read, so a short
closing line never vanishes) and each line (cut into chunks at blank gaps
past 16 widths) is read on its own;
every other block keeps its whole crop, which manga-ocr reads better. The
block's lines become the overlay's `lines`. The decoder is an in-house KV-cache
merged export (BERT decoder + past key values, `use_cache_branch` — optimum's
CLI refuses to build past for bert, so it is two manual `torch.onnx.export`
graphs fused by `merge_decoders`, then int8: Constants and weight Transposes
must be folded into initializers first or quantize_dynamic sees nothing).
Every axis is batched, so one run advances a whole 4-crop batch in lockstep
(rows all start at START together — always rectangular; validated
token-exact vs solo decode). Merged decode is ~2.6x faster than full-prefix
at identical CER (the full-prefix fallback is gone — the merged file is the
only shipped decoder); the file (~30MB) ships same-origin from
`public/ocr-models/` — like every OCR model file now: Hugging Face, where
the weights originate, is unreachable without a VPN in some regions (and it
has no merged variant anyway). The recognition encoder picks its
weights by execution provider (`detectPreferredEp`, cached in localStorage
`yuki-ocr-ep`): wasm → int8 (fastest CPU GEMM), WebGPU → q4f16 (MatMulNBits
is the only quantization with a native GPU kernel — measured ~12x faster
than int8-on-wasm per block, while int8/fp16 on WebGPU are SLOWER than wasm,
gpuweb#5292). A WebGPU session-build failure falls back to wasm (the q4f16
MatMulNBits ops run on CPU too). The detector follows the same EP split:
WebGPU → an in-house fp16 build (~85MB, converted in-house from ogkalu's
fp32 export, shipped same-origin) measured ~68ms/page — 19x faster than the
43MB int8 build on wasm (~1.3s/page) — at the same boxes (int8 weights on
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
parallel HTTP ranges, then forever from IndexedDB — and every worker reads
its own copy from that cache (~165MB per worker); the main thread never
holds the bytes. Per-page results land in
`mangaOcr` (keyed `bookId/pageIndex`, with an engine version that forces a
re-run when the pipeline changes). Every sidecar-less volume goes through
the same pipeline: DETECT writes skeleton blocks for every page (final
boxes, empty lines — ~10x cheaper; every queued volume's detect runs before
any recognition, so a batch import un-gates every volume early), then the
recognition MARCH works through the remaining pages in order whenever a
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
pipeline in Node over whole volumes — pixels resampled by a real headless
Chrome canvas, as in the app's worker — and scores it against `.mokuro`
references (closeness to another OCR run) and vision-verified golden files
(`tests/golden/`: consensus blocks plus hard blocks read off the crop where
two pipeline variants disagreed; pages found by image name), with a
`--gate` mode (each golden file carries its own recall/CER/runaway
thresholds, exit 1). A runaway there is also a 5–12-glyph phrase looping
4+ times — the decoder's own guard cuts only 2..4-token cycles, so such a
loop (論バランスは勿論論バランスは…, rare: a block per few volumes, old
pipeline too) still runs to the token cap. Measured and settled (Nov 2026, かぐや様 + 推しの子
full volumes): fp32 or fp16 recognizer weights buy nothing over int8 (the
older "fp32 buys 2.5pp" predates the full detector); manga-ocr's own beam
search (4 beams, no-repeat trigrams) reads WORSE than greedy here and costs
1.7x; line-by-line reading only pays under ~18px glyphs (from 18px up it
loses — stray marks at line ends); flipping a block's orientation against
its line spacing interleaves columns. The price of the current pipeline
over the pre-Nov one: +7.5% crops, recognition +9% on WebGPU (kaguya 208
→ 227 ms/page on a quiet M3 Pro). The best recognizer on the hard
blocks is Baberu OCR v1.2 (Apache-2.0, 122MB; half the failed blocks of
manga-ocr) but it decodes ~5x slower per crop in the browser (batch-1
graphs) — parked as a candidate quality path, not shipped. Research and
numbers: `docs/Исследования/` (outside git).

## Touch reading

Fingers get their own grammar in every reader (mouse, wheel and keys stay
as they are): the screen splits into three bands — the outer ones turn the
page, the middle one shows the **controls** (the top pill plus a bottom
**scrubber** bar: drag to preview a position, let go to jump; it fills from
the right in right-to-left books). Right-to-left books (vertical Japanese,
manga) turn FORWARD on the left band and on a swipe to the right — the
finger pulls the next page in from the left. A phone opens a book with the
controls up; a page turn puts them away. Text books follow the finger with
resistance and slide the new page in; manga is a live **pager** — the
neighbouring spreads wait preloaded on either side of the track, the drag is
1:1, release velocity decides turn or stay and carries into the spring.
The **page-turn animation** can be switched off (Settings → Reading, and the
reader's quick settings on a touch screen; it syncs like the theme): then
nothing slides or follows the finger — a tap or a swipe just flips the page,
in every reader. Pinch, pan and the double-tap zoom keep their motion.
Pinch zooms manga around the fingers, a zoomed page pans inside its bounds,
a double tap on the middle band zooms to that spot and back. A tap opens an
OCR box; a tap elsewhere closes it. Phones get the whole screen: manga drops
its outer margin, a landscape phone reads spreads, every floating control
clears the system insets (Dynamic Island, home indicator, sensor housing).

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

## Sync

**Sync** keeps one library across a person's devices — positions, pins,
renames and series, deletions, the daily statistics and the taste settings
(interface language, reading theme, font, weight, furigana, the manga cover
option, the daily goal, shelf sort and section order). Font size, line height,
margins and folded sections stay per device: a phone and a Mac want different
ones. Manga **OCR results** travel too: a volume recognized on one device
arrives with its text on the others, and they never recognize it again.

**Book files** follow: a book imported on one device appears on the others.
EPUB and PDF go to the cloud on their own; a manga volume only when its
series is set to **Keep in the cloud** (series menu) — a volume weighs
hundreds of MB and free clouds hold 2–5 GB. A book is uploaded once, by the
device that had it first, as one encrypted stream cut into 8 MB chunks —
a few dozen requests per volume instead of one per page (each request to a
cloud through a VPN costs ~0.5–0.9 s before a byte moves) — three in
flight each way, retried on a hiccup, resumed where a broken upload
stopped. Book chunks live apart from the reading state, so a round stays
quick however big the library grows; uploads run on a budget each round
and the next round picks up at once, so reading state never waits. On another device a novel or a PDF up to 25 MB just
arrives; manga and bigger files wait in the shelf's **On your other
devices** section as tiles — a tap downloads the book onto the shelf (it
opens when tapped there, not on its own). A
downloaded volume can be **removed from this device**: it stays in the cloud
or on the device it came from. A book deleted everywhere, or a series no longer kept in
the cloud, has its files taken out of the cloud by the device that uploaded
them. A full cloud stops uploads (Settings says so), never reading sync.

A book is **offered only once it is ready** on its device — a novel or a
PDF once its import is stored, a manga volume once every page has text,
from its sidecar or from a finished in-app OCR at the current engine. Until
then it isn't uploaded, isn't sent directly, and the other devices show it
as a dimmed tile with a ring of that device's real progress (the same look
as a volume being processed on its own shelf; a tap does nothing yet) — a
quiet sign that it's coming, with no new words, rather than a book that
silently isn't there. The volume then travels **with its text**: the OCR
rides at the end of the pack, cloud or direct, and lands in storage before
the book does, so it is never on a shelf without it. A device **never
recognizes a volume it received** — not in the background pass on start,
not in the reader; only volumes imported on it. When the OCR engine
changes, the devices that imported a volume recognize it again and publish
the new text (the volume's OCR pack); the others keep the volume and wait
for that text. Packs uploaded before 1.4.5 carry no text: they are not
uploaded again — the receiver takes the text from the volume's OCR pack
right after the pages, and a volume whose device hasn't finished it waits
as a dimmed tile like any other.

Settings → Sync says what is moving and nothing else: the last sync, a thin
bar along it while a round runs (the other devices' changes read, this
one's published, book files checked), and a row per book on its way — up
to the cloud, down from it, or straight from another device — with its
share done. The devices sit in their own group.

**Straight from another device**: a book that never went to the cloud —
manga above all — still shows on the other devices, as a tile **On Mac**.
Each device publishes a sealed **catalog** of what it holds (titles, sizes,
small covers); a tap rings that device through the cloud (a sealed WebRTC
offer and answer, good for two minutes) and the book comes over a direct
encrypted connection as the same stream a cloud pack is cut from — at the
speed of the home network, no size limit, nothing stored in the cloud. Both
devices need yuki open meanwhile: every syncing device answers from the
moment the app opens (Dropbox wakes it at once through its long-poll, Yandex
is asked every few seconds). A tap rings EVERY device whose catalog lists
the book (two browsers on one Mac are two devices) and the first to answer
sends it. The tile says where it stands: **Calling Mac…**, **Connecting…**,
and only after 20 s without an answer **Open yuki on Mac** — over a VPN a
ring that is answered takes 5–10 s, so anything sooner would cry wolf. The
transfer starts once the device is opened (within a minute and a half); a
failure says which way it failed — nobody answered, or no direct connection
came up. A tap prefers the cloud when the pack is there. The sender stays
within 16 MB of what the receiver has STORED (it acknowledges as it writes),
so a 300 MB volume never piles up in a phone's memory.

Sync stays light on memory — iOS kills a page that grows too big, and it
comes back in a reload loop. A device's catalog never loads a book to
describe it (a volume's size comes from its page records; a novel's or a
PDF's isn't shown), and a pack of an older format is sent again only by the
device that uploaded it, not by every device holding the book. There is no relay:
two devices that can't reach each other directly (strict NAT on different
networks) can't swap books this way — the cloud path remains.

**Account-free Wi-Fi sync** is the first option in Settings. The first device
shows a short code and approves the second. `worker/` is a separate Cloudflare
Worker at `pair.yukireader.app`: per-room Durable Objects forward only encrypted
WebRTC signaling, never library data. Codes expire after five minutes and are
replaced with a random 256-bit secret after approval. Pairings live in the
`yuki-peers` IndexedDB and reconnect automatically. Persistent WebRTC connections
carry framed metadata updates and independent book channels; reading updates
do not resend unchanged covers. The same merge engine, device identity, book
keys and statistics store serve both transports. Cloud file references and
cloud encryption keys never cross the pairing boundary. OCR updates can travel
separately for manga already stored on a device. Direct rounds run first and can
interrupt a cloud request; disconnecting the cloud preserves paired devices.
Both apps must stay open. Novels arrive automatically, manga and large books
remain downloadable tiles. There is no TURN/file relay, so devices must be
directly reachable, normally on the same Wi-Fi.

Cloud sync is optional. The person connects THEIR cloud — **Yandex Disk** or
**Dropbox**, the only two that let a static site sign in once with no secret
and stay signed in — and yuki works inside the app folder it is given
(`Приложения/<app>`, `/Apps/<app>`). Everything there is **end-to-end
encrypted** on the device: the cloud sees opaque files, the developer sees
nothing at all. The **library key** lives in the cloud only wrapped by the
**recovery key** (`XXXX-XXXX-…`, shown once on the first device, saved to
Passwords or written down); another device opens the library with it, and
keeps working on its own after that. Losing every device AND the recovery key
loses the cloud copy — by design, nobody can open it.

A **device** is one browser storage: Safari and the home-screen app on the
same iPhone are two devices (their storage is separate). Each device writes
only its own files in the cloud and reads everyone else's; nothing is ever
overwritten by another device, so there are no conflicts at the storage level.

**Content key** — a book's identity across devices, from its content alone
(EPUB: the text; PDF: the file bytes; manga: page sizes and the first bytes of
each page), never the file name — the same volume named differently on two
devices is still one book. The shelf's duplicate check keeps its own hash.

How values meet:
- a **position** is the place last lingered on (the 3-second dwell)
  anywhere — opening a book or importing it claims nothing, and a device that
  has never read a book never moves it. When another device read FURTHER, the
  reader offers "On Mac you read up to 45% · Go there";
- pins, renames, series and settings: the latest change wins (clocks that
  never run backwards; a device whose clock runs far ahead is not believed);
  on joining, a device takes the library's existing organization;
- **statistics** add up: every device publishes only its own counters, so
  nothing is counted twice and re-syncing changes nothing;
- a **deletion** follows to the other devices — but never removes a book a
  device has not synced yet, and more than a few deletions at once wait for
  the person to confirm. An empty or unreadable cloud file means "unknown",
  never "everything was deleted".

Sync runs while the app is open (phones give web apps no background time): on
start, on returning to the app, after edits (a few seconds later), when the
network comes back and every minute. Offline nothing changes for reading —
the edits wait and go out later. The first sync keeps a snapshot; for a week
Settings offers to put positions, pins and settings back as they were.

Because the sync token and the key live in the browser, book HTML is
sanitized before it reaches the page (no handlers, scripts, frames, remote
media) and the built site ships a Content-Security-Policy: a book can't run
code in the app.

## Distribution

Yuki is a static website, not an app. Reader data (shelf, progress, stats)
lives in the browser's IndexedDB and survives deploys — a site update never
touches the library. After the first visit the site is fully cached by a
service worker and works offline. A new version doesn't interrupt reading:
the updated worker waits in the background, and the quiet "New version
ready" card offers to reload now — otherwise the next natural visit applies
it. Hosting is Cloudflare Pages, connected to the repository: every push to
`main` is built there (`pnpm typecheck && pnpm test && pnpm build` — a red
check means no deploy) and goes live at yukireader.app; other branches get
preview URLs. Version tags `v*` mark releases. OCR models above the host's
25 MiB file cap ship as parts and are joined on download. One changelog — `CHANGELOG.md` at the root; the
"About yuki" group in Settings is built from it too.

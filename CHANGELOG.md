# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning — [SemVer](https://semver.org/).

## [1.3.2] - 2026-08-02

- Progress transfer: compact export/import actions support customizable Yuki backups and ttsu backup ZIPs; OCR models are never included
- Dictionaries: keep installed dictionaries in a compact list, then add Yomitan-compatible ZIPs or recommended English-English, English-Russian and Japanese-English packages from a modal
- Settings: dictionary installation now uses a flat list with compact, borderless ZIP import controls
- Novels: page turns now respond to arrow keys and scrolling, not clicks on the reading surface
- Reader: hold Shift over EPUB or OCR text to open a dictionary definition popup
- Reader: Noto Serif JP is now the default font, font choices use selects, and controls hide after two seconds with a smaller fullscreen reveal zone
- Reader: focused controls keep their arrow keys, and novel position percentages are rounded to one decimal
- Reader: the control pill hides one second after the pointer leaves, while its reveal handle fades out after two seconds; outside clicks hide the pill immediately
- Reader: Light pages use a warmer white for easier reading
- Reader: font weight can be adjusted from Settings and quick reader settings
- Buttons: loading keeps the original variant, disables the action, and replaces its icon with a spinner
- Reader: Light pages now use a softer warm near-white

## [1.3.1] - 2026-08-02

- Manga OCR: real 197- and 226-page volumes now finish 1.9–2.0× faster, dropping from 95 to 46 seconds and from 145 to 78 seconds; recognized text and box placement stay identical

## [1.3.0] - 2026-08-02

- Library: language sections and the novels/manga subsections fold into a cover stack — click the section title or the stack to unfold; the state persists

## [1.2.9] - 2026-08-02

- Full screen: the control pill parks below the system menu bar — all buttons respond again
- Contents and Search open as floating cards level with the control pill
- Scrolling inside a side panel scrolls the panel, not the book behind it

## [1.2.8] - 2026-08-02

- Updates now arrive in minutes, not the better part of an hour — the app's home moved to faster, VPN-free hosting

## [1.2.7] - 2026-08-02

- Updates: the Update button can no longer get stuck — a tab that lost track of the waiting update now simply reloads onto the new version

## [1.2.6] - 2026-08-02

- Novels: page-turn hover now works across the full reader surface, while text keeps its normal copy cursor
- Updates: the Update button now applies the new version without clearing your library

## [1.2.5] - 2026-08-02

- Reader: click anywhere beside a manga page to turn it; the pointer shows where it works
- Manga: two-page spreads have no gap, and the first page can be used as a cover
- Novels: selecting text no longer turns the page, and the font can be made much larger
- Reader: jump straight to a manga page or a position in a novel
- Reader: controls are easier to find, and Escape exits novels and manga
- Manga: zoom out further and move the page at any scale

## [1.2.4] - 2026-08-01

- The OCR models now travel with the app itself — no VPN needed anywhere anymore: the one-time download simply works, its progress bar is honest from the very first byte, and a damaged download quietly heals itself instead of breaking recognition

## [1.2.3] - 2026-08-01

- The one-time OCR model download now tells the truth and takes care of itself: the progress bar can never run past 100% again, a dropped connection quietly picks up where it left off instead of giving up — and the panel says it upfront that this hefty download happens only once

## [1.2.2] - 2026-08-01

- Manga reader: zooming out no longer re-centers the page or drags it sideways — the point under the cursor stays put in both directions, panning is free of bounds, and only a page turn resets the view

## [1.2.1] - 2026-08-01

- Manga: a whole new shelf format — volumes group into numbered series with reordering and per-volume progress, and the reader flips right-to-left, cover alone then two-page spreads, like a real tankōbon
- Manga OCR: drop a raw scan archive in and the app reads it itself — WebGPU detector plus an int8 batched decoder march through ~60 pages a minute in the background, while a queue panel tracks every volume and keeps it locked until it's actually ready
- Manga OCR: text boxes sit exactly on their bubbles — hover to reveal, click to pin and select; box text now mirrors the print (calibrated against real mokuro data), always fits, and never sticks open
- Reader: wheel zoom toward the cursor got punchier, with drag-pan while zoomed — and pages can no longer be dragged away as ghost images or stained by stray text selections

## [1.1.0] - 2026-08-01

- Reader: horizontal (English) EPUB is real pages now — margins on every side, a book-like line measure, a two-page spread on wide screens (like the PDF view); the Japanese vertical path is unchanged
- Reader: full-page illustrations (covers) fit their page again — no more blank first pages or bottoms clipped at the fold
- Reader: invisible calibre accessibility strips no longer break section page counts or spawn phantom pages

## [1.0.1] - 2026-07-31

- Batch import: books land on the shelf instead of opening right away
- Chrome polish: symmetric reader pill, quieter borders, softer dock shadow

## [1.0.0] - 2026-07-31

First public release.

- Library: covers, rename, delete, duplicate guard
- Novels (EPUB): vertical and horizontal layout, pagination that never clips a glyph at any zoom
- Books (PDF): two-page spreads, page background follows the reading theme
- Statistics: characters, time, day streak, activity heatmap, daily goal
- Bookmarks: automatic return to the last reading position
- Interface: English and Russian, follows the browser, switchable in Settings
- Works fully offline after the first visit

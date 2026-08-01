# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning — [SemVer](https://semver.org/).

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

# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning — [SemVer](https://semver.org/).

## [1.5.0] - 2026-11-06

- Moving around a zoomed manga page is smooth now: when you lift your finger the page glides to a stop instead of jerking and freezing, and double-tap zoom no longer jumps

## [1.4.9] - 2026-11-05

- Connect your devices by code to sync books, reading progress and statistics over Wi-Fi, without signing into Dropbox or Yandex Disk
- Paired devices reconnect automatically; books share the live connection and interrupted transfers retry without leaving incomplete copies
- Cloud sync is optional and a slow or disconnected cloud no longer holds up direct transfers

## [1.4.8] - 2026-11-05

- The update notice sits at the bottom, above the tab bar, with room for manga recognition progress
- Sync no longer draws a glowing strip across the top of the screen
- Books transfer faster between your devices, simultaneous downloads no longer interfere, and an interrupted connection retries automatically
- Large manga volumes with lots of text or a large cover can transfer directly without hitting the connection's message limit

## [1.4.7] - 2026-11-05

- yuki has a face now: Yuki-chan in her snowy beanie is the new icon on your home screen, in the browser tab and in the installed app

## [1.4.6] - 2026-11-05

- Reading: after copying a bubble's text and checking a translation in another app, pages turn again the moment you come back — no more stuck pages or the page slowly zooming out on its own
- Sync: a book you download from your other devices now waits on the shelf instead of jumping straight into the reader
- Sync: while yuki syncs, a thin band of light runs along the top of the screen — you can see it's working without anything getting in the way of your reading
- Manga: on a phone the series header no longer pushes "Add volume" off the screen — it's a compact + button next to the menu
- The progress pill for recognizing manga sits centered above the tab bar, and the "new version" card moved up to where notices appear
- The tab bar captions no longer clip the tails of letters like y and g
- Settings → Sync: "Undo" and "Disconnect this device" look like the rest of the app's buttons

## [1.4.5] - 2026-11-05

- Phone: fixed yuki crashing and reloading over and over while recognizing manga text — a phone now recognizes one page at a time, using half the memory
- Sync: a manga volume reaches your other devices only once your Mac has finished reading its text — the phone gets it ready to read, text and all, and never spends its own battery recognizing it again
- Sync: a volume your Mac is still working on shows on the phone dimmed, with a ring of how far along it is; tap it once it's ready
- Sync: Settings → Sync shows what's moving right now — a thin bar while it syncs, and every book on its way up or down with its progress; your devices have a group of their own
- Sync: a book coming down from the cloud or the Mac fills a progress bar right on its cover

## [1.4.4] - 2026-11-04

- Reading: don't like the page sliding? Turn off "Page-turn animation" in Settings → Reading (or right in the reader's quick settings on a phone) — taps and swipes then just flip the page, in novels, PDFs and manga alike

## [1.4.3] - 2026-11-04

- Sync: fixed the phone's page crashing and reloading over and over ("a problem repeatedly occurred") — sync no longer loads every book into memory on each start, so reading and syncing stay light even with a big library
- Sync: a phone no longer re-sends books your Mac already put in the cloud, which was eating its memory and battery after the last update
- Sync: a big manga volume coming straight from the Mac arrives at the pace the phone can store it, instead of piling up in memory

## [1.4.2] - 2026-11-04

- Sync: getting a book straight from your Mac no longer tells you to open yuki there while it's already open and answering — the tile says "Calling Mac…", then "Connecting…", and asks you to open yuki only if nobody picks up
- Sync: use yuki in more than one browser on the Mac? The phone now calls all of them at once, and whichever is open sends the book
- Sync: when a direct download can't happen, the message says why — the other device didn't answer, or it couldn't be reached over this Wi-Fi (a VPN can get in the way)
- Sync: the Mac is ready to send books the moment yuki opens, and a VPN quietly dropping the connection no longer leaves it deaf to the phone

## [1.4.1] - 2026-11-04

- Sync: books move between your devices up to ten times faster — a manga volume now goes up and comes down in a few dozen big encrypted pieces, several at once, instead of page by page, so it's mostly as quick as your connection allows
- Sync: reading positions and stats stay snappy no matter how many books you keep in the cloud
- Sync: a flaky connection no longer stalls a transfer — it retries on its own and carries on where it stopped
- Sync: manga doesn't need the cloud any more — a volume on your Mac shows up on the phone as "On Mac"; tap it while yuki is open on the Mac and it comes straight over your Wi-Fi, as big as it likes, without touching your cloud space
- Sync: if yuki isn't open on the other device, the tile says so — open it there and the download starts on its own

## [1.4.0] - 2026-11-04

- Sync: your books travel now, not just your place in them — import a novel or a PDF on the Mac and it shows up on the phone by itself
- Sync: turn on "Keep in the cloud" for a manga series and its volumes wait on your other devices as cloud tiles — tap one and it downloads and opens
- Sync: done with a volume on the phone? Remove it from the device to free the space — it stays in the cloud and on your Mac
- Sync: big uploads go a bit at a time and pick up where they stopped, so your reading never waits for them; a full cloud only pauses uploads and says so in Settings
- Sync: when the cloud can't be reached, the message now says so plainly and hints at the VPN, instead of claiming there's no connection

## [1.3.9] - 2026-11-04

- Icons are light outlines now and fill in only for what's active — the section you're in, the panel you opened, the book you pinned — so the interface reads calmer and the current place stands out at a glance

## [1.3.8] - 2026-11-04

- The app starts faster and needs far less memory with a big library: a book's text and pictures load only when you open it — a shelf of 27 novels now starts with about a fifth of the memory, a shelf with PDFs with a fifteenth
- Importing manga no longer freezes the app: archives and comic EPUBs unpack in the background, page after page, instead of all at once in memory — the shelf stays smooth while a volume comes in
- Importing a pile of books at once keeps the app responsive — they are read in the background, a few at a time
- Opening a book is quicker: counting its characters is about four times faster, with exactly the same numbers
- OCR: drop several volumes at once and every one of them opens sooner — all volumes get their text boxes first, recognition comes after
- OCR takes about 165 MB less memory while it works
- Manga text recognition reads crowded speech bubbles, long captions and small print far more accurately — blocks too dense to read in one go are now read column by column
- Finds more of the small text — asides, sound effects, page numbers — and colored pages read as cleanly as black-and-white ones
- Manga you already imported is quietly read again with the improved recognition in the background
- New icons drawn just for yuki: every button, menu and tab now shares one calm, solid look that stays crisp even at the smallest sizes
- Sync: connect your Yandex Disk or Dropbox once, and your reading positions, pins, renames, manga series, reading theme and font, daily goal and shelf order follow you between your phone and your Mac
- Sync: statistics add up across devices — a day you read on both the phone and the Mac counts all of it, and nothing twice
- Sync: manga already recognized on one device arrives with its text on the others, so your phone doesn't redo the OCR
- Sync: the same book imported on two devices is recognized as one, even when the files are named differently
- Sync: open a book you read further on another device and yuki offers to take you there instead of losing your place
- Sync: everything is encrypted on your device before it leaves — your cloud keeps only unreadable files, and yuki has no server that could ever see them
- Sync: a recovery key opens your library on a new device — keep it in Passwords or anywhere safe, it's shown only once
- Sync: no network, no problem — reading never waits, and your changes go out as soon as you're back online
- Books: a book file can no longer run hidden scripts inside the app — chapters are cleaned before they're shown

## [1.3.7] - 2026-11-03

- Phone: reading is made for your thumb now — tap the outer edges to turn pages (left goes forward in Japanese books and manga, right in English ones), tap the middle for the controls, or just swipe
- Phone: manga pages follow your finger and the next page is already waiting beside it — flick and it lands with the speed you threw it, a hesitant drag springs back, and turns feel instant because neighbouring pages load ahead
- Phone: pinch to zoom into a manga panel and drag around it, double-tap the middle to zoom straight to that spot and double-tap again to fit the page back
- Phone: a tap in the middle brings up the controls together with a page slider at the bottom — drag it to scrub through the whole book (right to left in Japanese books) and let go to jump
- Phone: manga uses the whole screen width, and turning the phone sideways shows two-page spreads like the printed book
- Phone: nothing hides under the Dynamic Island, the home bar or Safari's toolbar anymore — the shelf, the dock, the reader's controls and the page counter all stay clear, and the status bar takes on your page color while you read
- Phone: long-press a cover for its menu with roomy, finger-sized rows; typing in search or rename no longer zooms the whole page in
- Phone: the narrowest screens fold "Add book" into a single plus, so the shelf header always fits
- PDF: click the page counter to jump to any page, like in novels and manga

## [1.3.6] - 2026-11-02

- Manga that comes as an EPUB — store scans and calibre conversions — now opens in the manga reader with right-to-left spreads and OCR, instead of as a blank book
- Manga volumes named like "Title 1巻" now land in the right series with the right volume number

## [1.3.5] - 2026-08-11

- The app opens much faster — the library greets you right away, and the heavy reading screens load only when you actually open them
- Horizontal books: the end of a chapter no longer goes missing once fonts and illustrations settle in — every page stays reachable, and your place now holds exactly through window resizes

## [1.3.4] - 2026-08-04

- Reader: reading with a hover dictionary finally counts as reading — mouse movement keeps the clock running, so scanned minutes no longer vanish from your stats
- Library: covers now show a small progress ring, so you can see how far each book is without opening it
- Library: pin a book right from its cover — hover and the bookmark's ribbon slides out to meet you, one click drops it into place on a little spring — or from the right-click menu; pinned books lead their section in every sort order
- Library: language sections can be dragged into your own order — the section steps aside as you lift it and a dashed slot travels with your cursor to show exactly where it lands; the order sticks, and it travels with your backups
- Stats: new charts — minutes per day, your reading speed over the last two weeks, and the current book's pace with an honest "days left" estimate; weekday letters keep the days grounded, and every column answers a hover with exact numbers
- Stats: the activity heatmap now sits with the charts in one Statistics section, and every day opens a proper tooltip — the day's time, characters read, and the books you actually read that day, covers included

## [1.3.3] - 2026-08-03

- Reader: the control pill no longer drops over words you're scanning — it reveals only at a deliberate touch of the very top edge, and the little pull tab is gone for good

## [1.3.2] - 2026-08-03

- Progress transfer: export/import live in clear Settings rows with icon tiles, and imports validate the entire backup before touching the library — a broken ZIP can't leave data half-restored
- Progress transfer: live progress now names the actual work ("Book 3 of 12 · Page 145 of 226"), and a stalled transfer fails with a clear error instead of spinning forever
- Progress transfer: long exports and imports can be cancelled — export stops instantly, import stops after the current book, keeping the library consistent
- Progress transfer: customizable Yuki backups and ttsu backup ZIPs; OCR models are never included; successful imports confirm with a toast before the app reloads
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
- Transfers: dictionary installs and backup ZIPs report live stages and percentages, while archive work stays off the UI thread and successful downloads show a compact confirmation toast
- Dictionaries: lookup and installation are temporarily disabled while package delivery is fixed
- Reader: Light pages use a balanced cool near-white for easier reading
- Library: EPUB books whose internal links are percent-encoded (spaces or non-ASCII characters in file names) no longer import as empty

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

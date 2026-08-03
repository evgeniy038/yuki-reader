# AGENTS.md

## Mission

Make the smallest correct change that keeps the app working. Real
verification over guesses: run the checks, don't claim them.

## Commands

pnpm, never npm (`preinstall` enforces it).

- Install: `pnpm install`
- Dev server: `pnpm dev` → http://localhost:1420
- Type check: `pnpm typecheck`
- Unit tests: `pnpm test` — node-side smokes via tsx (epub parser,
  dictionaries, backup round-trip on fake-indexeddb)
- Focused: `pnpm test:epub` / `pnpm test:dictionaries` / `pnpm test:backup`
- Browser e2e: `pnpm test:backup-smoke` (plus test:layout, test:position,
  test:library, test:ocr-download) — real Chrome via playwright-core
  against the dev server; needs YUKI*TEST*\* fixture env vars, see
  tests/README.md
- Build: `pnpm build`

Run the narrowest relevant check first; broaden when the change crosses
core/UI boundaries. If a check can't run, say exactly which and why —
never claim it passed.

## Architecture

- `src/core/` — browser-free domain logic: book parsing (epub/pdf/manga),
  backup, storage over IndexedDB, dictionaries, OCR. Must stay runnable in
  node: unit tests import it directly.
- `src/components/` — React UI. `src/components/ui/` holds the primitives
  (Button, Dialog, Switch); use them before inventing new ones.
- `src/lib/` — shared helpers (i18n).
- `src/styles/` — global CSS and utility layers; the only place global
  styles may live.
- `tests/` — tsx scripts. Node unit smokes run on fake-indexeddb; browser
  smokes boot the dev server and click through the real UI.

## Rules

- Long-running work (archive pack/unpack, OCR) runs in a Web Worker, never
  on the UI thread — and reports honest, granular progress with a working
  cancel.
- User-facing text goes through i18n (`src/lib/i18n/en.ts`, `ru.ts`) — no
  hardcoded strings in components.
- Strict TypeScript: no `any`, no unsafe casts. Narrow `unknown` at trust
  boundaries (zip archives, backup files, IndexedDB records).
- Behavior changes need test changes. Tests must be honest: no vacuous
  asserts, no fake-green. A bug fix adds a regression fixture.
- Minimal diffs: no compatibility shims, no speculative abstractions, no
  drive-by reformatting.
- No new dependencies without asking first.
- No git mutations (commit/push/reset) unless the user explicitly asks.
- Browser checks: never edit `src/` while one is running — vite
  full-reloads and the run fails for phantom reasons. Kill stale dev
  servers for the same reason: a zombie vite serves a stale module graph.

## Versioning

Patch bumps only: 1.0.0 → 1.0.1 → … → 1.0.9 → 1.1.0, same inside each
minor line. A jump to a new minor or major is for a truly major update,
not for ordinary features or fixes. When in doubt, patch.

The current version lives in package.json; changelog headings follow it.

## Changelog

CHANGELOG.md tells the reader what they got. Write it like a person who
cares about the app talking to a person who uses it: what they can do
now, what feels better — one plain line per change, said like you mean
it. No file names, no function names, no internal jargon, no filler.
A change the user can't see or feel gets no entry.

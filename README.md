# yuki reader (ゆき)

**[yukireader.app](https://yukireader.app/)**

A quiet offline-first reader for Japanese novels (EPUB) and English books
(PDF). Runs in the browser, works fully offline after the first visit —
library, progress and stats stay local in IndexedDB.

- EPUB: vertical/horizontal layout, glyph-safe pagination, furigana
- PDF: two-page spreads, page background follows the reading theme
- Reading stats, automatic bookmarks, EN/RU interface

![Library](screenshots/library.png)

## Feedback

- Bug or broken rendering → [open an issue](https://github.com/evgeniy038/yuki-reader/issues/new/choose)
- Question, idea, anything else → [Discussions](https://github.com/evgeniy038/yuki-reader/discussions)

## Develop

```sh
pnpm install
pnpm dev        # http://localhost:1420
pnpm build      # production build to dist/
pnpm test       # parser smokes
```

## Release

Tags deploy to GitHub Pages: CHANGELOG entry → bump `version` in package.json →
`git tag vX.Y.Z && git push --tags`. First-time setup: Pages → Source:
GitHub Actions, and allow tag deployments (`v*`) in the `github-pages`
environment.

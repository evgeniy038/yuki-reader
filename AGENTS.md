# AGENTS.md

## Versioning

Releases bump the PATCH component only: 1.0.0 → 1.0.1 → … → 1.0.9, then
1.1.0 — and the same inside each minor line (1.1.1 … 1.1.9 → 1.2.0).

A dramatic bump — skipping to a new minor (like 1.0.x → 1.1.0) or a new
major (2.0.0) — is reserved for a truly major update, not for ordinary
features or fixes, even user-visible ones. When in doubt, patch.

Current line: v1.2.8 shipped 2026-08-02, so continue 1.2.9 → 1.3.0.

## User-facing writing

- Keep it short. Use bullets when there are several changes.
- Use plain words. No jargon, smart-sounding terms, or fluff.
- Say what the user can do or what got better. Skip implementation details.

## Changelog

CHANGELOG.md is written for the user, not from the commit diff. Every entry
says what changed for them and why it got nicer — plain, appetizing
language. No internals: no file names, no function names, no jargon. If a
change gives the user nothing they can see or feel, it gets no entry.

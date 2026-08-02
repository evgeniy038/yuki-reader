# AGENTS.md

## Versioning

Releases bump the PATCH component only: 1.0.0 → 1.0.1 → … → 1.0.9, then
1.1.0 — and the same inside each minor line (1.1.1 … 1.1.9 → 1.2.0).

A dramatic bump — skipping to a new minor (like 1.0.x → 1.1.0) or a new
major (2.0.0) — is reserved for a truly major update, not for ordinary
features or fixes, even user-visible ones. When in doubt, patch.

Current line: v1.3.1 shipped 2026-08-02, so continue 1.3.2.

## Changelog

CHANGELOG.md is user-facing: what changed and why it's better. Short,
technical, plain English. No fluff, no marketing tone, no internals (file
names, function names). A change the user can't see or feel gets no entry.

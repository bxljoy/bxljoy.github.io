# Implementation Plan: `site` — Alex Bao's Blog

Spec: [`SPEC-site.md`](../SPEC-site.md) · Tasks: [`todo.md`](todo.md)

## Overview

Fork AstroPaper v6.1 (Astro 7) into this repo, get it deploying to `https://bxljoy.github.io` early, then add the topic layer: a `topics` collection whose files own post membership + reading order, validated at build time, rendered as a topic-map homepage, per-topic reading paths, and topic-scoped prev/next on posts. Launch with one real post adapted from `database-isolation-levels-mvcc-and-anomalies`.

## Architecture Decisions

- **Template is copied, not tracked.** AstroPaper is copied into the repo without its git history. Upstream updates become manual cherry-picks — acceptable for a personal site, and keeps our diff simple.
- **Order lives in topic files** (`posts: [slug, …]`), not on posts. One edit to reorder; the `/blog` skill only appends a line.
- **Topic slugs reference post `id`s** (filename without extension, as Astro's glob loader produces). Posts stay flat in `src/content/posts/` — no subfolders, so ids and URLs stay identical.
- **Validation is a pure function** (`validateTopicMap`) called from one shared loader (`getTopicMap()` in `src/utils/topics.ts`) used by every page that needs topics. Any page build therefore fails with all problems listed. Unit-tested with Vitest, no Astro runtime needed.
- **"Published" = AstroPaper's existing `postFilter`** (not draft, publish time passed). Reuse it; do not invent a second definition.
- **Feature work happens on a branch; `main` = live.** Deploy runs on push to `main`, so topic work lives on `feat/topics` and merging it *is* the launch (requires author approval).
- **Node 24 + pnpm via corepack.** Your pnpm is currently installed only under Node 22 in nvm; `corepack enable` under Node 24 provides it.

## Dependency Graph

```
T1 scaffold ──► T2 deploy (fail fast on Pages/Actions)
   │
   └──► T3 first post (content, draft) ──┐
        T4 topic model + validation ─────┼──► T5 topic page ──► T6 post topic nav ──► T7 homepage map + nav
                                         │                                              │
                                         └──────────────────────────────────────────────┴──► T8 polish + verify ──► T9 launch (merge)
```

## Task List

### Phase 1: Foundation (on `main`)
- [x] T1: Scaffold AstroPaper with site identity
- [x] T2: Create GitHub repo + Pages deploy workflow

### Checkpoint A: Foundation
- [x] Template site (no demo posts) live at https://bxljoy.github.io
- [x] `pnpm build` clean locally and in Actions

### Phase 2: Topic layer (on `feat/topics`)
- [x] T3: Adapt first post from the vault (content only)
- [x] T4: Topics collection + `validateTopicMap` + unit tests
- [x] T5: Topic reading-path page `/topics/[slug]`
- [x] T6: Topic breadcrumb + topic-scoped prev/next on posts
- [x] T7: Topic-map homepage + header nav

### Checkpoint B: Topic layer
- [x] `pnpm test && pnpm build` pass
- [x] Broken topic file fails the build with a clear message
- [x] Home → topic → post → next flow works in `pnpm preview`
- [x] Author reviews the first post and UI

### Phase 3: Polish & launch
- [x] T8: About page, CI test step, mobile + Lighthouse verification
- [x] T9: Launch — merge `feat/topics` to `main` (author approval)

### Checkpoint C: Complete
- [x] All 8 spec success criteria met on the live site

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Pages source not set to "GitHub Actions" / first deploy fails | Med | T2 done first, before any feature work; verify live URL before continuing |
| Work-specific details leak into a post | High | Spec "Never" rule; T3 includes an explicit scrub pass; author reviews every post before merge |
| AstroPaper v6/Astro 7 internals differ from assumptions (ids, filters) | Med | Plan based on reading the actual v6.1 source; T4 tests use the real `postFilter` semantics |
| Validation only runs if a page calls the loader | Low | Every topic-aware page (home, topic, post) goes through `getTopicMap()`; T4 verifies a broken file fails `pnpm build` |
| pnpm/Node mismatch in nvm | Low | `.nvmrc` = 24, `corepack enable`; CI pins Node 24 as AstroPaper already does |

## Open Questions
- Topic name for the first post — proposed **"Postgres Internals"** (T3/T4); rename freely.
- Homepage tagline — proposed during T7.

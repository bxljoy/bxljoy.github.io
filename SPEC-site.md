# Spec: `site` — Personal tech blog (AstroPaper + topic reading paths)

> Module `site` in the capability map. Downstream module `drafting` (`/blog` skill) depends on the post + topic schema defined here.

## Objective

A public tech blog at **https://bxljoy.github.io** made of polished posts derived from the author's Obsidian notes. Its distinguishing feature is **browse by topic area, in reading order** — the site should read as a map of what the author knows, not a date feed.

**Users**
1. The author — rereads posts on any device; publishing is the learning loop.
2. Recruiters / peers arriving from LinkedIn or GitHub — should grasp "what does this person know" within one screen.

**User stories**
- As a visitor, I land on the homepage and see every topic area with a one-line description and post count.
- As a visitor, I open a topic and see its posts as a numbered reading path.
- As a reader of a post, I see "Part 3 of 7 · Postgres Internals" and can go to previous/next **within that topic**.
- As the author, I reorder a topic by editing one list in one file.
- As the author, the build fails loudly if the topic map and posts disagree, so the map never silently rots.

## Tech Stack

- AstroPaper **v6.1.x** (Astro 7, Tailwind v4, Pagefind search) — forked as a starting point, not a dependency
- Node **24** (`.nvmrc` → `24`), pnpm (as AstroPaper ships)
- Hosting: GitHub Pages via GitHub Actions (`withastro/action`), repo `bxljoy/bxljoy.github.io`, deploy on push to `main`
- Unit tests: Vitest (only new dependency)

## Commands

```
Install:  pnpm install
Dev:      pnpm dev                 # http://localhost:4321
Build:    pnpm build               # astro check + build + pagefind
Preview:  pnpm preview
Test:     pnpm test                # vitest run
Lint:     pnpm lint
Format:   pnpm format
```

## Content model

### Posts — `src/content/posts/<slug>.md` (existing AstroPaper schema, unchanged)

Existing fields kept: `title`, `description`, `pubDatetime`, `modDatetime`, `tags`, `draft`, `featured`. No topic field on posts — **membership and order live in the topic file** (single source of truth).

One optional addition for provenance (used by `drafting`, never rendered):

```yaml
sourceNotes: [database-isolation-levels-mvcc-and-anomalies, postgres-autovacuum-execution-and-tuning]
```

### Topics — `src/content/topics/<slug>.md` (new collection)

```yaml
---
title: Postgres Internals
description: How Postgres actually stores, versions, and durably writes your rows.
order: 2              # position on the topic map
posts:                # reading order, top to bottom
  - mvcc-and-isolation-levels
  - vacuum-and-bloat
  - wal-and-checkpoints
---
Optional intro paragraph shown at the top of the topic page.
```

### Invariants (enforced at build time)

1. Every slug in a topic's `posts` exists in the posts collection → else **build fails**.
2. Every **published** post appears in **exactly one** topic → orphan or duplicate **fails the build**.
3. Draft posts may be listed in a topic; they are hidden in production and the topic's numbering skips them.
4. Topics with zero published posts are hidden from the map.

## Pages & UX

| Route | Content |
|---|---|
| `/` | **Topic map**: short intro (who I am, what this is), grid of topic cards sorted by `order` (title, description, post count), then "Recently published" (3–5 posts) |
| `/topics/[slug]` | Topic title, intro, numbered reading path (title + description + date per post) |
| `/posts/[slug]` | Existing post layout + topic breadcrumb ("Part N of M · Topic") above title, and topic-scoped prev/next replacing AstroPaper's date-based adjacent nav |
| `/posts`, `/tags`, `/archives`, `/search` | Kept as secondary navigation |
| `/about` | Short bio + links (GitHub, LinkedIn) |

Header nav: **Topics · Posts · Tags · Search · About**.

Kept from AstroPaper: light/dark mode, dynamic OG images, RSS, sitemap. Removed: demo posts, share links other than LinkedIn/X/mail, "edit post" link.

## Project Structure

```
src/content/posts/          → published + draft posts (.md)
src/content/topics/         → one file per topic (NEW)
src/content.config.ts       → add `topics` collection, `sourceNotes` on posts
src/utils/topics.ts         → pure functions: validateTopicMap, getTopicForPost, getReadingPath (NEW)
src/utils/topics.test.ts    → unit tests (NEW)
src/pages/index.astro       → topic map homepage (REPLACED)
src/pages/topics/[slug].astro → topic reading path (NEW)
src/pages/topics/index.astro  → redirect/alias to `/` or full map (NEW)
src/components/TopicCard.astro, TopicNav.astro (NEW)
astro-paper.config.ts       → site identity, socials
.github/workflows/deploy.yml → GitHub Pages deploy (NEW); keep ci.yml for PRs
SPEC-site.md, SPEC-drafting.md, tasks/  → project docs
```

## Code Style

Follow AstroPaper's existing conventions (TypeScript, Prettier + ESLint configs as shipped, `@/` import alias). Topic logic stays in pure functions so it is testable without Astro:

```ts
// src/utils/topics.ts
export type TopicProblem =
  | { kind: "missing-post"; topic: string; slug: string }
  | { kind: "orphan-post"; slug: string }
  | { kind: "duplicate-post"; slug: string; topics: string[] };

export function validateTopicMap(
  topics: { id: string; posts: string[] }[],
  publishedSlugs: string[],
  allSlugs: string[],
): TopicProblem[] { /* ... */ }
```

A single call site (topic map page `getStaticPaths` or a shared loader) throws with every problem listed, so one build run reports all issues.

## Testing Strategy

- **Unit (Vitest)** — `src/utils/topics.test.ts`: missing slug, orphan post, duplicate membership, drafts skipped in numbering, prev/next at path ends, empty topic hidden.
- **Build as integration test** — `pnpm build` must pass; a deliberately broken topic file must fail it (verified once manually, noted in PR).
- **Manual/browser** — mobile width (375px) check of `/`, a topic page, and a post page; Lighthouse ≥ 90 on performance and accessibility for `/`.
- CI runs lint, format check, test, and build on PRs; deploy workflow runs build before publishing.

## Boundaries

- **Always:** run `pnpm test && pnpm build` before committing; keep topic ordering only in topic files; keep AstroPaper's code style.
- **Ask first:** adding dependencies beyond Vitest; creating the GitHub repo / enabling Pages; buying or configuring a custom domain; changing the post schema in ways `drafting` depends on; publishing any post (flipping `draft: false`).
- **Never:** commit content from the Obsidian vault verbatim; publish anything derived from work-specific notes (`fop-*`, `translation-service`, `commerce-lab`, Klarna / employer / client / internal-system material); commit secrets; force-push `main`.

## Success Criteria

1. `https://bxljoy.github.io` is live and deploys automatically on push to `main`.
2. Homepage shows the topic map; each topic page shows a numbered reading path in the order of its topic file.
3. Post pages show "Part N of M · <Topic>" and topic-scoped prev/next.
4. Moving a slug within a topic's `posts` list changes the order everywhere after rebuild — no other file edited.
5. A topic referencing a nonexistent post, or a published post in no topic, fails `pnpm build` with a message naming the file and slug.
6. At least **one real post in one topic** is published (hand-written or hand-adapted — AI drafting comes in `drafting`).
7. Lighthouse on `/` (mobile): performance ≥ 90, accessibility ≥ 95.
8. Pages are readable at 375px width with no horizontal scroll.

## Decisions

- **Site title:** Alex Bao's Blog · author: Alex Bao
- **Socials:** GitHub https://github.com/bxljoy · LinkedIn https://www.linkedin.com/in/xiaolei-bao-aa4b7b257/
- **First post:** adapted by hand from `database-isolation-levels-mvcc-and-anomalies`

## Open Questions

1. **Initial topic list** — propose 5–8 topics from vault tags (e.g. Postgres Internals, Java Concurrency, JPA & Spring Data, Distributed Systems Patterns, AI Coding Agents); author confirms/renames during implementation. Only the first post's topic is needed for launch.
2. **Homepage tagline** — one line under the title; propose during implementation.

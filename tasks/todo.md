# Tasks: `site`

Plan: [`plan.md`](plan.md) · Spec: [`../SPEC-site.md`](../SPEC-site.md)

---

## Task 1: Scaffold AstroPaper with site identity

**Description:** Copy AstroPaper v6.1 into this directory (no upstream git history), remove demo content, set identity (Alex Bao's Blog, author, URL `https://bxljoy.github.io/`, timezone, socials GitHub + LinkedIn + mail), disable "edit post", trim share links to LinkedIn/X/mail, add `.nvmrc` (`24`), `git init` on `main`. Keep SPEC/tasks files.

**Acceptance criteria:**
- [x] No AstroPaper demo posts or "Mingalaba"/AstroPaper copy remain on any page
- [x] `astro-paper.config.ts` reflects Alex Bao's identity and socials
- [x] Initial commit on `main`

**Verification:**
- [x] `pnpm install && pnpm build` succeeds (Node 24, pnpm via corepack)
- [x] `pnpm dev` → header shows "Alex Bao's Blog", footer socials link to GitHub + LinkedIn

**Dependencies:** None
**Files likely touched:** `astro-paper.config.ts`, `src/content/posts/*` (deleted), `src/pages/index.astro` (hero text only), `src/content/pages/about.*`, `.nvmrc`
**Estimated scope:** M

---

## Task 2: Create GitHub repo + Pages deploy workflow ⚠️ ask first

**Description:** Create public repo `bxljoy/bxljoy.github.io`, add `.github/workflows/deploy.yml` (checkout → `withastro/action` with Node 24 → `actions/deploy-pages`) on push to `main`, set Pages source to "GitHub Actions", push.

**Acceptance criteria:**
- [x] Push to `main` triggers a green deploy run
- [x] https://bxljoy.github.io serves the scaffolded site with working CSS, search page, and RSS

**Verification:**
- [x] `gh run watch` → success
- [x] `curl -sI https://bxljoy.github.io` → 200; open in browser

**Dependencies:** T1
**Files likely touched:** `.github/workflows/deploy.yml`
**Estimated scope:** S

## Checkpoint A: Foundation
- [x] Live URL works · build clean locally and in Actions · author glances at the live site

---

## Task 3: Adapt first post from the vault (content only)

**Description:** On branch `feat/topics`, write `src/content/posts/mvcc-and-isolation-levels.md` (working slug) adapted from vault note `database-isolation-levels-mvcc-and-anomalies`: rewritten as a blog post (intro that motivates the problem, explanation, examples, gotchas), not a copy of the note. Scrub any work/employer-specific references. Frontmatter: title, description, pubDatetime, tags, `sourceNotes`. Author reviews and edits.

**Acceptance criteria:**
- [x] Post reads as a standalone article; no Obsidian wikilinks, no work-specific names
- [x] `sourceNotes` records the vault note slug
- [x] Author has reviewed and approved the text

**Verification:**
- [x] `pnpm dev` renders the post correctly (code blocks, tables, headings)
- [x] `grep -iE 'fop|klarna|translation-service|commerce-lab|\[\[' src/content/posts/` → no hits

**Dependencies:** T1
**Files likely touched:** `src/content/posts/mvcc-and-isolation-levels.md`, `src/content.config.ts` (`sourceNotes` field)
**Estimated scope:** S

---

## Task 4: Topics collection + `validateTopicMap` + unit tests

**Description:** Add `topics` collection (`title`, `description`, `order`, `posts: string[]`) to `src/content.config.ts`. Implement pure functions in `src/utils/topics.ts`: `validateTopicMap`, `getReadingPath` (published posts in listed order), `getTopicForPost` (topic + index + total + prev/next). Add `getTopicMap()` loader that fetches both collections, applies `postFilter`, validates, and throws listing every problem. Add Vitest (`pnpm test`). Create `src/content/topics/postgres-internals.md` listing the first post.

**Acceptance criteria:**
- [x] Missing slug, orphan published post, and duplicate membership each produce a named problem
- [x] Drafts listed in a topic are excluded from reading path + numbering, not reported as errors
- [x] Topics with zero published posts are omitted from the map

**Verification:**
- [x] `pnpm test` → all topic tests pass
- [x] Temporarily add a bogus slug to the topic file → `pnpm build` fails naming file + slug; revert

**Dependencies:** T3
**Files likely touched:** `src/content.config.ts`, `src/utils/topics.ts`, `src/utils/topics.test.ts`, `package.json`, `src/content/topics/postgres-internals.md`
**Estimated scope:** M

---

## Task 5: Topic reading-path page `/topics/[slug]`

**Description:** `src/pages/topics/[slug].astro` renders topic title, body intro, and a numbered list (title, description, date) in topic order. `src/pages/topics/index.astro` lists all topics (full map, reused by homepage in T7 via a `TopicCard` component).

**Acceptance criteria:**
- [x] `/topics/postgres-internals` shows posts numbered 1..N in topic-file order
- [x] Reordering the `posts` list changes the page order with no other edit
- [x] Topic with zero published posts → no page generated

**Verification:**
- [x] `pnpm build && pnpm preview` → manual check; swap order of two slugs (add a throwaway second draft→published post locally if needed) and confirm

**Dependencies:** T4
**Files likely touched:** `src/pages/topics/[slug].astro`, `src/pages/topics/index.astro`, `src/components/TopicCard.astro`
**Estimated scope:** S

---

## Task 6: Topic breadcrumb + topic-scoped prev/next on posts

**Description:** In `src/pages/posts/[...slug]/index.astro`, replace date-based prev/next with `getTopicForPost` results. Add `TopicNav` component above the title: "Part N of M · <Topic link>". Reuse the existing `AdjacentPostNav` markup with topic-scoped posts.

**Acceptance criteria:**
- [x] Post shows "Part N of M · Postgres Internals" linking to the topic page
- [x] Prev/next go to neighbours *within the topic*; none shown at path ends
- [x] Pagefind ignores the breadcrumb (`data-pagefind-ignore`)

**Verification:**
- [x] `pnpm build && pnpm preview` → check first, middle, last positions (use a local 3-post fixture topic, not committed)

**Dependencies:** T5
**Files likely touched:** `src/pages/posts/[...slug]/index.astro`, `src/components/TopicNav.astro`, `src/pages/posts/[...slug]/_components/AdjacentPostNav.astro`
**Estimated scope:** S

---

## Task 7: Topic-map homepage + header nav

**Description:** Replace `src/pages/index.astro` content: hero (name, one-line tagline, socials), topic cards sorted by `order` (title, description, post count), then 3–5 recently published posts. Header nav → Topics · Posts · Tags · Search · About (Archives remains reachable but not in nav).

**Acceptance criteria:**
- [x] Homepage shows every non-empty topic as a card in `order`
- [x] "Topics" nav item active on `/` and `/topics/*`
- [x] Recruiter test: within one screen at 375px, you can see who Alex is and at least the first topic card

**Verification:**
- [x] `pnpm build && pnpm preview` at desktop and 375px width
- [x] Author approves tagline and layout

**Dependencies:** T5
**Files likely touched:** `src/pages/index.astro`, `src/components/Header.astro`, `src/i18n/lang/en.*` (nav label)
**Estimated scope:** M

## Checkpoint B: Topic layer
- [x] `pnpm test && pnpm build` pass · broken topic fails build · home → topic → post → next works
- [x] Author review

---

## Task 8: About page, CI test step, mobile + Lighthouse verification

**Description:** Write a short About (who, what this blog is, links). Add `pnpm test` to `ci.yml` and deploy workflow gate. Run Lighthouse (mobile) on `/` and a post; fix issues found. Check 375px for horizontal scroll on home, topic, post (incl. wide code blocks/tables).

**Acceptance criteria:**
- [x] Lighthouse mobile on `/`: performance ≥ 90, accessibility ≥ 95
- [x] No horizontal page scroll at 375px on home, topic, post
- [x] CI fails if topic tests fail

**Verification:**
- [x] Lighthouse report numbers recorded in the PR/commit message
- [x] Browser check at 375px

**Dependencies:** T6, T7
**Files likely touched:** `src/content/pages/about.*`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
**Estimated scope:** S

---

## Task 9: Launch — merge `feat/topics` to `main` ⚠️ ask first

**Description:** With author approval, merge to `main`; watch deploy; verify live site against all spec success criteria. Author adds the URL to LinkedIn + GitHub profile.

**Acceptance criteria:**
- [ ] All 8 success criteria in `SPEC-site.md` verified on https://bxljoy.github.io

**Verification:**
- [ ] `gh run watch` success; manual walkthrough on phone

**Dependencies:** T8
**Files likely touched:** none (merge)
**Estimated scope:** XS

## Checkpoint C: Complete
- [ ] Spec success criteria met · then start `SPEC-drafting.md` (`/blog` skill)

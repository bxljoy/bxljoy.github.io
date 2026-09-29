# Spec: `drafting` — the `/blog` skill

> Module `drafting` in the capability map. Depends on `site` (post schema with `sourceNotes`, topic files owning order).

## Objective

Turn "a vault note → a published post" into a repeatable procedure with the same rules every time, replacing the manual steps used for posts 1 and 2. Alex stays in control: the skill recommends and drafts; only Alex publishes.

## Commands

| Invocation | Behavior |
|---|---|
| `/blog` | Recommend 3–5 unpublished, publishable notes, each with a reason and a proposed topic placement. No files changed. |
| `/blog <note-slug>` | Draft the note as a post on branch `post/<slug>`, add it to a topic, verify, start the dev server, stop for review. |
| `/blog publish` | Fast-forward the current `post/*` branch into `main`, push, watch the deploy, verify the live post. |

Location: `~/.claude/commands/blog.md` (user-level, next to `/note`).

## Rules

- **Content follows the note** — same section order, definitions-first flow, the note's own wording and examples. No invented hooks or examples. Polish only for readability.
- **Remove:** interview-prep sections and phrasing ("Interview framing/answers", "memorize"), project/employer-specific sections, meta-comments about the vault, `interview-prep`-style tags.
- **Wikilinks:** link to the post if the target note is already published (via `sourceNotes`); otherwise plain text or drop.
- **Never source:** `fop-*`, translation-service, commerce-lab, Klarna / employer / client material, mock-interview logs, personal plans/backlogs.
- **Topics:** append to an existing topic's `posts:` list. If no topic fits, propose a new topic file (title, description, order) and wait for approval.
- **`pubDatetime`** = current local time (a future time silently hides the post).
- **Never publish without an explicit "publish"**; never force-push; `main` stays deployable.

## Success Criteria

1. `/blog` lists only unpublished, non-private notes, with a placement for each.
2. `/blog <note>` produces a post that builds, appears in its topic with correct "Part N of M", passes the privacy scrub, and is served at a local URL — without touching `main`.
3. `/blog publish` results in the post returning 200 on https://bxljoy.github.io with the right topic position.
4. First real test: post 3.

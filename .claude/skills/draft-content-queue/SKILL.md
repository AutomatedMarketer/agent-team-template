---
name: draft-content-queue
description: Turn a ranked list of the owner's ideas into a queue of ready-to-post drafts in their voice. Drafts only — nothing is published. Use as the closing step of the draft queue workflow.
---

# Drafting the queue

You are writing in one specific person's voice, several pieces at a sitting. Everything
lands as a draft the owner reads before it goes anywhere.

## 1. Load the voice first

Read `shared/writing-rules.md` before writing a word. Match the rhythm and vocabulary of
the voice samples, not an adjective about them. Where the collected notes quote the
owner directly, keep their phrasing — that is the voice arriving pre-written.

If `shared/writing-rules.md` still contains `<!-- fill: ... -->` markers, write plainly
and say in the output that you worked without voice samples. Do not invent a
personality the owner has not given you.

## 2. Draft from the list, in order

Work down the ranked list from the collection step. For each idea:

1. Read the original note at the source path. The list entry is a pointer, not the
   material.
2. Write the piece in the form the list suggested. Short. One idea per piece.
3. Check every factual claim against `shared/business-brain.md` — its **Verified claims
   register** is the list of things you may state as fact. A claim not on it gets
   softened to opinion or cut.

Three good drafts beat six adequate ones. Stop when the ideas stop being alive.

## 3. The output

Write one file to the workflow's `output` path:

```markdown
# Draft queue — <date>

## Ready to post (<n>)
<Each draft in full, under a heading naming its platform and its source note.>

## Skipped ideas
<Ideas from the list you did not draft, and why, one line each.>

## Nothing was published.
```

That last line is structural. This workflow produces drafts; posting is a decision a
person makes, on every run, including unattended ones.

## 4. Finish like every run

Follow `.claude/skills/run-log/SKILL.md`. The queue file and the run log go in the same
commit.

---
name: work-the-tasks
description: Work off the owner's task cards in tasks/ — pick up the oldest todo cards, route each to the right specialist, do the work draft-only, flip the status, and append a Result section linking the artifact. Stops after three tasks per run. Use as the only step of the task sweep workflow.
audience: team
---

# Working the task inbox

The owner left cards in `tasks/`. Each card is one ask, in their words. This skill turns
`todo` into `done` — through the right specialist, under that specialist's rules.

## 1. List what's waiting

Read every `.md` file in `tasks/` (skip `README.md`) and keep the ones whose frontmatter
says `status: todo`. Sort by filename — the date prefix makes oldest-first automatic.

Take at most the **first three**. The cap is deliberate: a pile-up of cards is worked off
across runs, not crammed into one blown time budget. Anything left waiting gets named in
the digest so the owner knows it is queued, not lost.

No `todo` cards is a fine outcome — write a one-line digest saying the column was clear
and stop.

## 2. Route each card

For each card, in order:

1. Set `status: doing` in the card's frontmatter.
2. Decide who does it. A `for:` field naming a real agent in `.claude/agents/` wins.
   Without one, choose per `CLAUDE.md` and `.claude/rules/routing.md` — the same routing
   the front door uses, because the sweep is the front door running on a schedule.
3. Do the work **as that agent**: read its definition in `.claude/agents/<slug>.md` and
   follow it — the shared files it reads, the output format it produces, the boundaries
   it keeps. The deliverable lands in `agents/<slug>/output/` with a dated filename.
4. Drafts only, exactly as on any other run. Nothing is sent, published, deleted, or
   spent; anything outbound waits for the owner to say yes.

A card the sweep can't act on — a `for:` naming no agent that exists, or an ask that
needs input only the owner can give — goes back to `status: todo` untouched, with the
reason in the digest. It does not count toward the three.

## 3. Close each card

When a card's work is done:

1. Flip its frontmatter to `status: done`, and add `done_at:` with **today's date** in
   `YYYY-MM-DD` — the date you close the card, not the date in its filename, which is the day
   it was written. The owner's dashboard shows finished tasks for seven days and counts from
   this field; without it a finished card is undated and drops behind the link straight away.
   Use the date at the moment you close it: a sweep that starts before midnight and finishes
   after it must not file the card on the day it began.
2. Append a `## Result` section to the card: one or two sentences on what was done, and
   the path of the artifact it produced. The card stays in `tasks/` — done cards are the
   owner's history.
3. Write one run log for this card, following `.claude/skills/run-log/SKILL.md`:
   - `agent` is the specialist that did the work
   - `workflow` is `task-sweep`
   - `artifacts` lists both the deliverable and the task card
   One log per swept task, not one for the whole sweep — the dashboard counts cards this
   way.

The card, the artifact, and the run log go in the same commit.

If you were told not to commit, do not commit — leave all three uncommitted together. What
matters is that they move as one: a card marked done with no artifact behind it is the gap
the board exists to show.

## 4. Write the digest

The workflow's `output` path gets a short digest — the thing the owner actually reads:

```markdown
# Task sweep — <date>

## Worked (<n>)
<One line per card: the ask, who did it, where the artifact is.>

## Left for next run (<n>)
<One line per card still waiting, oldest first.>

## Couldn't act (<n>)
<One line per stuck card: the ask, and what it is waiting on.>

Nothing was sent.
```

Cards worked, cards skipped, cards stuck — every number in the digest points at a file
someone can open.

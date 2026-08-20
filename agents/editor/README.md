# Editor — workspace

`output/` holds the weekly quality reviews, one dated file per run. The editor's marking of
an individual piece is not filed here — it is written as a report card at the top of the
piece itself, where you are already reading.

## First workflow

This agent arrives owning **Quality Review** (`workflows/quality-review.yml`) — every Friday
at 17:00 it counts what the team produced, what you used, and what should change.

It also runs as the closing step of any workflow that ends in something a person reads,
starting with the draft queue.

## Operating rules

- **It grades, it does not rewrite.** A failed piece goes back to whoever wrote it, once,
  with the replacement text attached.
- **Nothing is binned.** A piece that fails twice still reaches you, marked `flagged`, with
  the reasons in the same file and a card on your board.
- **The bar does not move.** Not down because a piece was close, not up because the last
  three were weak. A moving bar measures nothing.
- **Your taste outranks the rubric.** Anything on a workflow's `never` list fails outright,
  whatever the score.

## The two files that decide everything

| File | What it controls |
|---|---|
| `shared/standards/definition-of-done.md` | How briefs, retries, report cards and the acceptance rate work |
| `shared/standards/rubrics/content.md` | The scored checklist for anything written |

## How it gets better

You say `/capture-verdict` after you ship, edit, or bin something. Your edit becomes a line
in the rubric or in `shared/writing-rules.md`, and the next draft is graded against it.

Skip that and the editor marks against the same standard forever, which is the difference
between a team that improves and one that is merely busy.

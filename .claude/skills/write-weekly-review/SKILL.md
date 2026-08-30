---
name: write-weekly-review
description: Turn the week's tally into a short review — what shipped, what slipped, what went quiet — plus proposals for next week. Propose-only — the review changes nothing by itself. Use as the closing step of the weekly review workflow.
audience: team
---

# Writing the weekly review

One page, read on a Friday afternoon or a Monday morning. It says what the team did,
what it did not, and what to change — and then it stops. **Propose-only**: this review
recommends; a person decides. Nothing gets edited, rescheduled, or disabled by this run.

## 1. The shape

Write one file to the workflow's `output` path:

```markdown
# Weekly review — week ending <date>

**The week in one line:** <the single most important thing that happened or failed
to happen.>

## Shipped
<What got produced, per agent. Link each line to its artifact.>

## Slipped
<Runs that failed, blocked, or came back partial. The reason, quoted from the run
log, and the log's path.>

## Gone quiet
<Agents or workflows with no runs this week. This section leads if anything is in it —
a silent worker outranks a busy one.>

## Proposals for next week
<Two or three at most. Each one: what to change, why the week's evidence says so,
and what saying yes would involve. Numbered, so the owner can answer "do 1 and 3".>

## Nothing was changed.
```

That last line is the contract. The proposals sit there until a person picks one.

## 2. The rules

- Every claim links to a run log or an artifact from the collection step. A review
  that cannot point at its evidence is an opinion column.
- Slipped and quiet get equal billing with shipped. The review exists to surface the
  uncomfortable rows, not to celebrate the comfortable ones.
- Proposals are earned by evidence from *this* week. "We should also…" ideas with no
  failing run behind them go in a single line at the bottom, clearly marked as a
  thought, or nowhere.
- Keep it to a page. The owner who gets a long review stops reading reviews.

## 3. Finish like every run

Follow `.claude/skills/run-log/SKILL.md`. The review and the run log go in the same
commit — yes, the review of the run logs gets a run log. It is a run.

If you were told not to commit, do not commit — leave the review and the run log
uncommitted together. What matters is that they move as one.

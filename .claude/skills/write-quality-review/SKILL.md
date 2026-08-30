---
name: write-quality-review
description: Count what the team produced this week, what the owner actually used, and what the verdicts say should change — reported as one acceptance-rate figure with the evidence behind it. Use as the only step of the quality review workflow.
audience: team
---

# The weekly quality review

One question, answered with numbers the owner can check:

> **What share of this week's work did you use without editing?**

That is the acceptance rate, and it is the only honest measure of whether the team works. A
week with forty runs and three accepted pieces is not a productive week.

## 1. Count the runs

Read every run log in `runs/<YYYY-MM>/` with `started_at` inside the last seven days. Keep
the ones that carry a `quality` block — those are the graded outputs. Runs with no `quality`
block are jobs that produced nothing to grade, and they are counted separately, not ignored.

## 2. Count the verdicts

Read `quality/verdicts/` for the same seven days.

```
acceptance rate = shipped / (shipped + edited + rejected)
```

**Count what no bucket holds, and say it.** A verdict whose value is not one of the three is not
part of either half of that fraction, so dropping one does not report a worse week - it reports a
better one. `npm run check:verdicts` refuses them, but if you meet one, report it beside the rate
as "N verdicts could not be counted" rather than leaving it out.

**Verdicts, not grades, decide acceptance.** The editor's score says the work met the
standard; the verdict says the owner used it. When those two disagree, the standard is wrong.

If a graded piece has no verdict, it is **unreviewed** — not accepted. Report the unreviewed
count next to the rate, because an acceptance rate calculated from three verdicts out of
twenty is noise, and presenting it as a clean percentage is the most misleading thing you
could do this week.

**With no verdicts at all, the rate is uncomputable, and that is what to say.** Not 0%. Zero
per cent means the owner used none of the week's work; uncomputable means nobody has said yet.
Those are opposite findings — one is a broken team, the other is an unclosed loop — and the
arithmetic cannot tell them apart because `shipped / 0` is not a number. Write:

```
**Acceptance rate: uncomputable — no verdicts filed this week.**
<n> outputs are waiting on one. Nothing here says the work was bad; nothing here says it was
good either.
```

Then skip the comparison to last week entirely rather than printing a direction of travel
between two things that were never measured.

## 3. Find the disagreements

The two rows worth the owner's attention:

| Pattern | What it means |
|---|---|
| Editor **passed**, owner **rejected** or **edited** | The rubric is missing something the owner cares about. Name the rubric line that should exist |
| Editor **flagged**, owner **shipped** anyway | The bar is set too high, or a `never` item is too blunt. Say which |

Both are rubric problems, not writer problems. Say which file you would change and what the
new line would say — then stop. Changing the standard is the owner's call, made through
`/capture-verdict`.

## 4. The output

Write the workflow's `output` path:

```markdown
# Quality review — week ending <date>

## Report card

**Made:** This week's acceptance figures across <n> graded outputs.
**Quality:** n/a — this is the review itself
**Confidence:** high | medium | low — <based on how many outputs carried a verdict>
**Sources:** runs/<YYYY-MM>/ (<n> logs), quality/verdicts/ (<n> verdicts)
**Needs you:** <the single rubric decision, or "nothing">

## The number

**Acceptance rate: <n>% — <shipped> of <verdicted> outputs used unedited.**
<n> graded outputs had no verdict yet.
<With zero verdicts, use the uncomputable line above instead of this one.>

Last week: <n>%. <Direction in one sentence, or "no prior week to compare.">
<Omit this line entirely when the rate is uncomputable - there is no direction of travel
between two things that were never measured.>

## By workflow

| Workflow | Ran | Graded | Passed | Flagged | Shipped | Edited | Rejected |
|---|---|---|---|---|---|---|---|

## Where the grader and you disagreed
<One line per disagreement, with the rubric line that should change. Or "none this week.">

## Rules added this week
<Every rule written by /capture-verdict, and the file it went into.>

## What ran but produced nothing to grade
<Workflows with runs and no quality block, one line each.>
```

## 5. Read the direction, not the number

A first month below 50% is normal and is not a failure of the team. What matters is whether
the rate climbs as verdicts accumulate. If four weeks of verdicts have produced no rules,
say that outright — an unclosed loop is the finding, and it is more important than the
percentage above it.

## 6. Finish like every run

Follow `.claude/skills/run-log/SKILL.md`. The review file and the run log go in the same
commit. This run has no `quality` block of its own — the reviewer is not graded by itself.

If you were told not to commit, do not commit — leave the review file and the run log
uncommitted together. What matters is that they move as one.

# quality/ — what you did with the work

`runs/` records what your team **produced**. This folder records what you **used**. They are
not the same thing, and the gap between them is the only honest measure of whether the team
works.

    quality/verdicts/2026-08-21-hiring-post.md

## One verdict per piece

Each file is one reaction to one output, filed by `/capture-verdict` after you say what you
did with it. Three values, nothing else:

| Verdict | Meaning |
|---|---|
| `shipped` | Used as written. **This is the one that counts toward acceptance rate** |
| `edited` | Used, but you changed it first. The change is the useful part |
| `rejected` | Not used |

```markdown
---
run_id: 2026-08-21T0700Z-content-draft-queue
artifact: agents/content/output/2026-08-21-hiring-post.md
rubric: content
verdict: edited
graded: 11/12
---

# Hiring post

## What changed
Opening was "Hiring is hard for small agencies." Replaced with "I hired three people last
year and got two of them wrong."

## The rule this becomes
Open on something that happened to me, never on a category statement about the industry.
```

## Check it

```bash
npm run check:verdicts
```

Every other artifact here has a checker - `runs/` has `validate:runs`, `ledger.yml` has
`check:ledger`, `workflows/` has `check:arming`. This one had none, and it is the file the
acceptance rate is computed from. A verdict whose value is not one of the three is not counted as
a bad week; it leaves the fraction entirely, so a mistyped rejection **raises** the rate.

## The rule is the point

A verdict that does not change a file is a diary entry. Every `edited` or `rejected` verdict
writes its lesson into the place a grader will actually read it — `shared/writing-rules.md`,
the verified claims register, a workflow's `never` list, or a new rubric line.

That is the loop. Without it your corrections live in your head and tomorrow's draft repeats
the mistake.

## The signal worth watching

**A piece the editor passed and you rejected.** That is not a writer problem — it is the
rubric missing something you care about, and it is the most valuable row in the weekly
review. `workflows/quality-review.yml` reports it every Friday.

## Ten seconds, or it stops happening

Capturing a verdict costs you one sentence. If it ever costs more than that, the loop breaks,
because you will stop doing it — and a loop nobody closes is worse than no loop at all.

# Definition of done

A workflow's `output` field says **where** the work lands. It does not say whether the work
was any good. This file is the missing half.

Every job your team does answers two questions before it starts:

1. **What does good look like?** — the brief
2. **Who checks?** — the rubric, and the agent that reads it

Without those, a team produces volume. With them, it produces work you can use. That is the
whole difference between a demo and an employee.

---

## 1. The brief

A brief is three lines at the top of a workflow. It is written once, in the owner's words,
and it is the thing the grader marks against.

```yaml
done:
  looks_like: A post I could publish unedited, in my voice, one idea, under 200 words.
  must_have: [a hook that works without the image, one concrete example, no claim outside the register]
  never: [hashtag stacks, "in today's fast-paced world", a claim with no source]
```

| Field | What it is |
|---|---|
| `looks_like` | One sentence. The finished thing, described as if you were handing it to someone. |
| `must_have` | The short list that has to be present. Three to five items. If it is longer, the job is two jobs. |
| `never` | The things that fail it outright, no argument, no judgement call. |

**Write `never` from your own edits.** The fastest way to fill it is to look at the last five
drafts you rewrote and ask what you deleted every time.

---

## 2. The rubric

The brief is per-job. The rubric is per-craft, and it is shared across every job of that
kind. `shared/standards/rubrics/content.md` is the one that ships.

A rubric is a scored checklist. Each line is either met or not met — no half marks, because
half marks are how a grader talks itself into passing something.

The score is `met / total`. The **threshold is 80%**, and any `never` item from the brief is
an automatic fail regardless of score. A piece can tick every box and still fail on one
`never` — that is deliberate. The `never` list is where your taste lives.

---

## 3. What happens when it fails

**Retry once, then flag.** Not "flag only", which trains you to stop reading the scores. Not
"hard block", which hides from you what the team is bad at.

```
draft  ->  grade  ->  pass          ->  lands in your inbox, marked passed
                  ->  fail (1st)    ->  back to the writer with the reasons, once
                  ->  fail (2nd)    ->  lands on your board marked "needs a look",
                                        with the grader's reasons attached
```

A flagged piece is **still delivered**. You see the draft and the reason it failed in the
same place. What you must never get is silence, or a clean board that is clean because the
work was quietly binned.

---

## 4. The report card

Every run ends the same way, so you can read any job from any team without learning a new
format. This block goes at the top of the output file — above the work, not below it.

```markdown
## Report card

**Made:** <what exists now that did not before, one line>
**Quality:** <n>/<total> against <rubric> — passed | flagged | retried once, then passed
**Confidence:** high | medium | low — <the one sentence that explains the rating>
**Sources:** <every claim's source, or "no external claims made">
**Needs you:** <the one decision only you can make, or "nothing">
```

`Needs you` is the field that matters. An agent that never needs you is either doing
something trivial or hiding a decision it should not have made alone.

---

## 5. How quality compounds

The loop closes when your edit becomes a rule.

1. A draft lands.
2. You ship it, edit it, or bin it.
3. You say `/capture-verdict` and describe what you changed and why.
4. The verdict is filed in `quality/verdicts/`, and the reason is written into the
   rubric's `never` list or into `shared/writing-rules.md`.
5. The next draft is graded against the rule you just made.

Skip step 3 and the team resets to zero every morning. That is the single difference between
a team that gets better and a team that is merely busy.

---

## 6. The number

`workflows/quality-review.yml` runs weekly and reports one figure:

> **Acceptance rate — the share of this week's outputs you shipped without editing.**

It is the only honest measure of whether your team works. A team that ran fifty jobs and had
four accepted is not a team that ran fifty jobs. Watch the direction, not the number: the
first month is meant to be bad, and the verdicts are what fix it.

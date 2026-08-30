# Rubric — written content

Marked by the `editor` agent against anything the `content` agent produces: posts,
captions, newsletters, scripts.

Each line is **met or not met**. No half marks — a half mark is how a grader talks itself
into passing something. Score is `met / 12`. **Threshold is 10/12 (80%).**

Any `never` item in the workflow's `done` block is an **automatic fail** regardless of the
score. The rubric measures craft; the `never` list is the owner's taste, and taste wins.

**On a run with no workflow** — a direct request rather than a chained job, which is how most
content gets written — there is no `done` block to read. Use the `never`-shaped lists that always
exist instead: `claims-to-avoid` and any "never" line in `shared/business-brain.md`, and
`hard-boundaries` in `shared/about-me.md`. Same rule, same automatic fail. A grader that skips the
taste check because the job arrived without a YAML file is grading half the thing.

---

## Voice — 4 points

| # | Met when |
|---|---|
| V1 | Read aloud, it sounds like the voice samples in `shared/writing-rules.md` — the rhythm, not just the topic |
| V2 | No sentence contains a word the owner does not use. Check the samples before deciding a word is "normal" |
| V3 | Where the source note quoted the owner directly, that phrasing survived into the draft |
| V4 | It opens like a person talking, not like an essay clearing its throat |

If `shared/writing-rules.md` still has `<!-- fill: -->` markers, V1–V3 are **not scored** —
mark them `n/a`, score out of 9 with a threshold of 7, and say plainly in the report card
that the piece was graded without voice samples.

## Substance — 4 points

| # | Met when |
|---|---|
| S1 | One idea. If you can split it into two posts without loss, it is two posts |
| S2 | At least one concrete, specific thing — a number, a name, a moment. Not a category |
| S3 | Every factual claim is on the **Verified claims register** in `shared/business-brain.md`, or is softened to opinion, or is cut |
| S4 | It tells the reader something they could not have written themselves |

**If the verified claims register is empty or every row reads `None`, S2 is scored differently.**
An empty register is not always a thin brain — someone who works for the business rather than
owning it may have no claim they are permitted to state, and that is the correct answer rather
than a gap to fill. In that case S2 is met by **a moment**: something that happened, told without
asserting a result, a figure, a client or a credential. Mark it met and say in the report card
that the piece was graded against an empty register, so the writer knows why it reads thinner
than it could.

Do not mark S2 not-met and then prescribe a replacement fact — that is a fix the writer is not
allowed to apply, and the retry it costs is wasted. If a registrable claim would obviously
improve the piece, write the register row it needs and who would have to source it, the way a
failure note names its fix.

## Craft — 4 points

| # | Met when |
|---|---|
| C1 | The hook works with the image or video removed |
| C2 | Nothing in it is filler — no "in today's world", no "let's dive in", no throat-clearing paragraph |
| C3 | It ends on a line worth ending on, not a summary of itself |
| C4 | Length fits the platform named in the brief, without padding to reach it |

---

## How to mark

Read the piece **once, all the way through, before scoring anything.** Scoring line by line
on a first pass makes a grader mark the sentences and miss the piece.

Then, for each line: quote the specific text that met it or failed it. A score with no quote
is an opinion, and the writer cannot act on an opinion.

```markdown
- V1 met — "so I just stopped doing it" matches sample 2's rhythm exactly
- S2 not met — "significant growth" is a category, not a number
```

## What a failure has to include

Never return a failure without the fix. Each unmet line gets **the replacement text**, not
advice about it.

Bad: *"S2 not met — needs to be more specific."*
Good: *"S2 not met — replace 'significant growth' with '11 to 34 clients in four months'
(source: business-brain, verified claims register)."*

The writer gets one retry. If the failure notes are not concrete enough to act on in one
pass, the retry is wasted and that is the grader's fault, not the writer's.

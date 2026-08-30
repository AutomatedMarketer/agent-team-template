---
name: capture-verdict
description: Turn the owner's reaction to a draft — shipped, edited, or binned — into a filed verdict and a written rule, so the same correction never has to be made twice. Use whenever the owner says what they did with a piece the team produced.
audience: team
---

# Capturing a verdict

This is the step that makes the team get better instead of merely staying busy. Without it,
your corrections live in your head and the next draft repeats the mistake.

It runs when the owner tells you what they did with something. They will not use the word
"verdict" — they will say *"I posted that one"*, *"I had to rewrite the opening"*, or
*"that was useless"*. All three are verdicts.

## 1. Find the piece

Ask only what you cannot work out. If they name it loosely — "yesterday's post" — resolve
it from `runs/` and the output paths, then say which piece you matched so a wrong guess is
caught immediately.

## 2. Get the diff, not the feeling

The useful part is **what changed**, not how they felt about it.

- *"I rewrote the opening"* — ask for the line they replaced it with. The replacement is the
  data; "the opening was weak" is not.
- *"It was fine"* — that is a `shipped` verdict, and it needs nothing else.
- *"Useless"* — ask the one thing that would have made it usable.

One question, maximum two. This has to cost the owner ten seconds or they will stop doing
it, and a loop nobody closes is worse than no loop.

## 3. File it

Write `quality/verdicts/<YYYY-MM-DD>-<piece-slug>.md`:

```markdown
---
run_id: 2026-08-21T0700Z-content-draft-queue
artifact: agents/content/output/2026-08-21-hiring-post.md
rubric: content
verdict: shipped | edited | rejected
graded: 11/12
---

# <Piece title>

## What changed
<The owner's edit. Old text, then new text, verbatim where you have it.>

## The rule this becomes
<One line, written as a rule a grader could mark against. Or "none — one-off.">
```

`verdict` is exactly one of three:

| Verdict | Meaning |
|---|---|
| `shipped` | Used as written. This is the one that counts toward acceptance rate |
| `edited` | Used, but changed first. Say what changed |
| `rejected` | Not used |

**Anything else is refused, not counted badly.** `npm run check:verdicts` rejects a value outside
the three, a piece or run that does not exist, a score above its own total, and a verdict with no
rule. Run it before you say the verdict is filed. A value the weekly review cannot bucket leaves
both halves of `shipped / (shipped + edited + rejected)`, so a mistyped rejection raises the
acceptance rate instead of lowering it.

**`graded:` is optional.** It is there when `review-draft` graded the piece. When the owner asked
an agent for something directly there is no score - write what you know, or leave the field out.
Never invent one.

**Watch for the gap that matters:** a piece the editor passed and the owner rejected. That
is the rubric being wrong, not the writer, and it is the most valuable signal in the folder.
Say so plainly when you see it.

## 4. Write the rule

A verdict that does not change a file is a diary entry. Put the rule where a grader will
read it:

| The correction was about | Write it into |
|---|---|
| Voice, phrasing, a word they never use | `shared/writing-rules.md` |
| A claim that should not have been made | the verified claims register in `shared/business-brain.md` |
| Something that should fail outright, every time | the `never` list in the workflow's `done` block |
| A gap the rubric does not measure at all | a new line in `shared/standards/rubrics/<craft>.md` |

Add the rule in the owner's words where you have them. A rule paraphrased into house style
stops sounding like the thing they actually said.

Then say which file you changed and read the new line back. A rule written into the wrong
file is invisible, and the owner has no way to notice.

## 5. Commit

The verdict file and the rule edit go in the same commit:

```bash
git add quality/verdicts/2026-08-21-hiring-post.md shared/writing-rules.md
git commit -m "verdict: hiring post edited - opening rule added to writing-rules"
```

No run log. This is the owner talking, not a run.

If the owner told you not to commit, do not commit — leave the verdict file and the rule
edit uncommitted instead. What matters is that they move together. A rule edit with no
verdict explaining it is a change nobody can trace back.

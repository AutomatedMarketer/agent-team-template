---
name: learn-from-the-week
description: Read the week's failures, verdicts and flagged work, find what went wrong more than once, and turn each repeated pattern into one exact file edit. Use as the second step of the weekly tune-up.
audience: team
---

# Learning from the week

The team already recorded everything it did. This step is the only one that reads it back and
asks **what should we do differently**, which is the difference between a system that
improves and one that merely accumulates history.

## The rule that keeps this honest

> **Twice, or it is not a pattern.**

One bad draft is a bad draft. The same weakness in two drafts is a missing rubric line. A
rule written from a single incident is usually wrong, and it makes the team worse while
looking like progress — so it is the one thing you must not do here.

State the count for every proposal. "Happened twice this week (Tuesday's post, Thursday's
newsletter)" is a proposal. "This could be improved" is not.

## 1. Read four sources

| Source | What you are looking for |
|---|---|
| `runs/<YYYY-MM>/` last 7 days | Every `failed`, `blocked`, `partial` run. The `evidence` field says what actually happened; the `summary` says what the agent believed |
| `quality/verdicts/` last 7 days | Every `edited` and `rejected` verdict. **The edits are the data** — what the owner changed, twice or more |
| `tasks/` | Cards still `todo` that the sweep could not act on, and every `flagged-*` card |
| The previous tune-up | `agents/orchestrator/output/` — the proposals it made |

## 2. Check the loop actually closed

Before proposing anything new, answer this: **did last week's proposals get done?**

- Done — say so in one line each.
- Still open — say so, and **do not propose them again**. Repeating an ignored proposal
  weekly is how a report becomes wallpaper.
- **Three weeks of proposals with none applied** — stop proposing. Report that single fact
  as the week's only finding. The bottleneck is not the team's learning, it is that nothing
  is being applied, and burying that under five new ideas hides the one thing that matters.

## 3. Find the repeats

Group by cause, not by symptom. Three drafts failing on three different rubric lines is
three one-offs. Three drafts failing on the same line is one pattern with a name.

Common shapes, and what each usually means:

| Pattern | Usually means |
|---|---|
| Same rubric line failing repeatedly | The writing guidance is missing something, not the writer |
| Editor **passed**, owner **rejected** — twice | The rubric is measuring the wrong thing. This is the most valuable finding available |
| Same connector blocking runs | A connector problem, escalated to a card, not a prompt problem |
| A workflow that never produces anything to grade | The job may not be worth its slot in the run cap |
| An agent's runs consistently `partial` | Its job is too big for one run, or its brief is vague |

## 4. Write at most three proposals

Three. Not eight. A tune-up that proposes eight changes gets none of them applied, and you
will read that same list back next Sunday.

Each proposal names **the file and the exact text**:

```markdown
### 1. Openings keep getting rewritten (3 times: Aug 18, Aug 20, Aug 21)

**File:** `shared/writing-rules.md`
**Add:** "Open on something that happened to me, never on a category statement about the
industry."
**Why:** all three edits replaced a category opening with a personal one.
```

A proposal without exact replacement text is advice, and nobody can apply advice.

## 5. Sort into applied and proposed

This is the line, and it does not move:

> **The tune-up may write down what it learned. It may not change how the team is wired.**

| Applied directly by the next step | Raised as a task card, for the owner |
|---|---|
| A rule into `shared/writing-rules.md` | Changing an agent's model |
| A line into a rubric in `shared/standards/rubrics/` | Pulling an upstream change |
| A claim into the verified claims register | Re-authorising or removing a connector |
| Anything already decided by a captured verdict | Rewriting a skill, adding or retiring a workflow |

If you cannot tell which column a proposal belongs in, it belongs in the right-hand one.

## 6. Hand off

Pass to `write-tune-up`: the loop-closure check, the repeats with their counts, the three
proposals, and which column each one sits in.

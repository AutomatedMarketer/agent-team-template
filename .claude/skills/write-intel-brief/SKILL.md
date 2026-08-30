---
name: write-intel-brief
description: Turn raw market findings into a short morning brief the owner can read in two minutes — most important thing first, a source behind every claim. Use as the closing step of the morning intel workflow.
---

# Writing the intel brief

The reader is a business owner with coffee in one hand and a phone in the other. They
get two minutes. The brief earns those two minutes or it stops being read by Thursday.

## 1. Lead with what matters

Open with the single most important thing that moved, in one sentence. Not background,
not "in today's brief" — the finding itself. Everything else ranks below it.

## 2. The shape

Write the brief to the workflow's `output` path:

```markdown
# Morning intel — <date>

**The one thing:** <the most important move, one sentence, with its source link.>

## What moved
<Three to six bullets, ranked. Each one: what happened, why this business cares,
source link.>

## Worth a look, not urgent
<Anything real but not actionable today. One line each.>

## Quiet lanes
<Which lanes turned up nothing. One line. "All quiet" is a valid brief.>

## Sources
<Every URL used, with what it supported.>
```

## 3. The rules that keep it honest

- Every claim in the brief traces to a finding with a URL. No orphan claims.
- Anything the scan marked `[unverified]` stays marked, or gets cut. It does not get
  quietly promoted to fact.
- "Why this business cares" comes from `shared/business-brain.md`, not from a guess.
  When the brain is empty, skip the interpretation and say so.
- Short beats complete. Six sharp bullets beat fourteen thorough ones.

## 4. Finish like every run

Follow `.claude/skills/run-log/SKILL.md`. The brief and the run log go in the same
commit.

If you were told not to commit, do not commit — leave the brief and the run log
uncommitted together. What matters is that they move as one.

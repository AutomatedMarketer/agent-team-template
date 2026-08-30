---
name: draft-chase-messages
description: Write one short follow-up message for each prospect the pipeline review found gone quiet, in the owner's voice, saved as drafts — nothing is sent. Use as the closing step of the gone-cold workflow.
---

# Drafting the chase messages

One message per cold prospect. Short, human, specific to them. Saved where the owner can
read it — sent by nobody but the owner.

## 1. Write from the record

For each prospect on the gone-quiet list:

1. Read their research file at `agents/sales/output/<date>-<prospect-slug>.md` when it
   exists — the "follow-up if there is no reply" section was written for exactly this
   moment. Use it as the starting point, not a script.
2. Reference what was actually sent last time. A chase that ignores the first message
   reads as automation, and automation is what gets deleted.
3. One idea, one ask, no guilt-tripping. "Bumping this" is a delete; a new small reason
   to reply is a response.
4. Match the voice in `shared/writing-rules.md` and `shared/about-me.md`.

A prospect whose row hints at why they went quiet — bad timing, wrong offer — gets a
message that acknowledges it, or a recommendation to let them go. Recommending "drop
this one" is part of the job.

## 2. The output

Write one file to the workflow's `output` path:

```markdown
# Gone cold — <date>

## Chase drafts (<n>)
<Per prospect: who, days quiet, the draft message in full, and where it should be
sent from when the owner approves it.>

## Let these go
<Prospects not worth chasing, one line each on why.>

## Pipeline health
<The two-line summary from the review step.>

## Nothing was sent.
```

Then update each chased prospect's row in `agents/sales/output/pipeline.md`: note the
chase draft and its date. The row records that a draft exists — not that contact was
made, because it was not.

## 3. Finish like every run

Follow `.claude/skills/run-log/SKILL.md`. The gone-cold file, the pipeline update, and
the run log go in the same commit.

If you were told not to commit, do not commit — leave them all uncommitted together. What
matters is that they move as one: a pipeline that moved with no message behind it is a
record nobody can follow back.

---
name: draft-replies
description: Write a reply for every message triage marked draftable and leave each one in the drafts folder — nothing is sent, on any run. Use as the closing step of the inbox triage workflow.
---

# Drafting the replies

Every message the triage step marked **needs a reply you can draft** gets one, written
in the owner's tone, left in drafts. The owner reads, edits if they want, and presses
send themselves.

## 1. Write from the sources, not from memory

For each draftable message:

1. Read the full thread, not just the triage line — replies written from a summary
   answer the summary.
2. Pull the answer from where the triage list said it lives: `shared/business-brain.md`
   or the customer-service FAQ. If the answer turns out not to be there, move the
   message to **needs a person** and say why. Do not improvise an answer to keep the
   count up.
3. Match the tone in `shared/about-me.md`. Short, direct, sounds like them.
4. Leave the reply in the drafts folder, attached to its thread.

## 2. The output

Write one file to the workflow's `output` path:

```markdown
# Inbox triage — <date>

**Window:** <what range of mail this covered>

## Needs you (<n>)
<One line each: who, what they want, why it needs a person. Most urgent first.>

## Drafted (<n>)
<One line each: who, what the draft says, sitting in drafts.>

## Handled (<n>)
<Counts by kind. No detail needed.>

## Nothing was sent.
```

That last line is not decoration. It is the thing the owner checks, and it is true on
every run because sending is not something this workflow can do — the boundary is
structural, not a promise.

## 3. Finish like every run

Follow `.claude/skills/run-log/SKILL.md`. The triage file and the run log go in the
same commit.

If you were told not to commit, do not commit — leave them both uncommitted instead. What
matters is that they move together, not that a commit always happens.

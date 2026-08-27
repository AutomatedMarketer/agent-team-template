---
name: review-draft
description: Grade a draft against its rubric and the workflow's done block before it reaches the owner, send it back once with concrete fixes when it falls short, and attach a report card either way. Use as the closing step of any workflow that produces something a person will read.
audience: team
---

# Grading the draft

The writing step is finished. Nothing has reached the owner yet. This step decides whether
what was written is usable, and it is the difference between a team that produces volume
and a team that produces work.

Delegate this to the `editor` agent with the `Task` tool. **Grading your own writing does
not work** — you already know what you meant, so you read the intention rather than the
words. The editor gets the draft and the rubric, and nothing about how the draft was made.

## 1. Load the standard

Read all three before marking:

- `shared/standards/definition-of-done.md` — how briefs, retries and report cards work
- `shared/standards/rubrics/<craft>.md` — the scored checklist. For anything the `content`
  agent wrote, that is `rubrics/content.md`
- the workflow file's `done` block — `looks_like`, `must_have`, `never`

If the workflow has no `done` block, mark against the rubric alone and say so in the report
card. Do not invent the owner's taste for them.

## 2. Mark it

Read the whole piece once before scoring anything. Then score each rubric line met or not
met — no half marks — quoting the exact text behind each call.

A hit on any `never` item is an automatic fail whatever the score.

## 3. Pass, or send it back once

**Passed** — write the report card at the top of the output file and finish.

**Failed** — hand it back to the writing step with the failure notes, once. Every unmet line
carries the replacement text, not advice about it. Then re-mark the rewrite and stop,
whichever way the second mark goes:

| Second mark | What happens |
|---|---|
| Passes | It lands. Report card says `retried once, then passed` |
| Fails again | It **still lands**, marked `flagged`, reasons attached — plus a task card (step 4) |

Never bin a draft. Never quietly drop one. A flagged piece and its reasons reach the owner
in the same file, because the reason is the useful part.

## 4. A second failure earns a card

Write `tasks/<YYYY-MM-DD>-flagged-<piece-slug>.md` so it shows on the owner's board:

```markdown
---
status: todo
for: editor
---

# Flagged: <piece title>

Failed <rubric> twice — <n>/<total>. <The single biggest reason, one line.>

Draft: `<path to the output file>`
```

One card per flagged piece. A piece that passed never gets a card.

## 5. The report card

Goes at the **top** of the output file, above the work:

```markdown
## Report card

**Made:** <what exists now that did not before, one line>
**Quality:** <n>/<total> against <rubric> — passed | flagged | retried once, then passed
**Confidence:** high | medium | low — <one sentence>
**Sources:** <every claim's source, or "no external claims made">
**Needs you:** <the one decision only you can make, or "nothing">
```

## 6. Record the grade

The run log gets a `quality` block — see `.claude/skills/run-log/SKILL.md`. The weekly
review counts acceptance from these, so a grade that is not recorded is a grade that never
happened.

```json
"quality": {
  "rubric": "content",
  "score": 11,
  "total": 12,
  "verdict": "passed",
  "retried": false
}
```

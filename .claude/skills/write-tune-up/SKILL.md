---
name: write-tune-up
description: Apply the week's learning to the team's written rules, raise everything that would rewire the team as a task card, and write the one-page tune-up report. Use as the closing step of the weekly tune-up.
---

# Writing the tune-up

Two steps found what moved and what should change. This step is where a report either
becomes a better team or becomes wallpaper.

## 1. Apply the left column

For each proposal marked **applied** — a rule, a rubric line, a verified claim — make the
edit now, in the owner's words where you have them.

- Add the line. Do not restructure the file around it.
- Never delete an existing rule to make room. If a new rule contradicts an old one, that
  contradiction is a **card for the owner**, not a decision for you.
- After each edit, read the new line back in the report so a rule written into the wrong
  file is visible immediately.

## 2. Card the right column

Everything that would rewire the team — a model change, an upstream pull, a connector fix, a
new or retired workflow — becomes one card in `tasks/`:

```markdown
---
status: todo
for: <the agent that would own the change, or omit>
---

# <The change, in one line>

**Found:** <what happened, with the count — "failed 3 runs since Aug 18">
**Change:** <the exact edit, file and text>
**If ignored:** <what keeps happening>
```

One card per change. Never bundle three changes into one card — a bundled card is refused
whole because of the one item the owner disagrees with.

**Urgent connector findings jump the queue:** a connector that is used but unreachable gets
its card written first, because the next scheduled run will fail at 6am whether or not
anyone read this report.

## 3. Write the report

The workflow's `output` path. One page. The owner reads this on a phone on a Sunday.

```markdown
# Weekly tune-up — <date>

## Report card

**Made:** <n> rules applied, <n> cards raised, <n> things checked.
**Quality:** n/a — this is the tune-up itself
**Confidence:** high | medium | low — <one sentence, lower it when a lane could not be checked>
**Sources:** runs/ (<n> logs), quality/verdicts/ (<n>), tasks/ (<n> open), <lanes checked>
**Needs you:** <the single most important card, or "nothing">

## Did last week's proposals get done?
<One line each. Or "first tune-up — no prior week.">

## What moved
**Models** — <up to date, or what shipped and what it means here>
**Changelogs** — <only what changes how this team works>
**Connectors** — <name and state, one line each. Never a key, never a URL with one>
**What we leverage** — <releases and commits, one line each>

## What we learned
<Each repeated pattern, with its count and the dates. Or "nothing happened twice this week.">

## Applied
<Each edit: the file, and the new line read back verbatim.>

## Raised for you
<Each card: its title and the one-line reason. Or "nothing needs rewiring.">

## Not checked
<Every lane you could not check, and why. This section is never omitted.>
```

## 4. "Nothing happened twice" is a real answer

A quiet week gets a short report that says so. Do not manufacture findings to fill a
template — an invented pattern becomes a rule, and a wrong rule makes every future draft
worse while looking like the system is working.

The **Not checked** section is never omitted either. A lane that silently disappears from
the report is how a team stops noticing it went blind.

## 5. Finish like every run

Follow `.claude/skills/run-log/SKILL.md`. The report, the applied edits, and any cards go in
the same commit. This run carries no `quality` block — the tune-up is not graded, it is the
thing that improves what gets graded.

```bash
git add inbox/<date>/tune-up.md shared/writing-rules.md tasks/ agents/orchestrator/output/last-checked.md runs/<YYYY-MM>/<run_id>.json
git commit -m "tune-up: 2 rules applied, 1 card raised for <date>"
```

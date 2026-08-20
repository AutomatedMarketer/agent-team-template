# tasks/ — your to-do column

Drop a card here and the team picks it up. Each task is one markdown file; the dashboard
shows this folder as your **To-do** column, and the daily **Task Sweep** works the cards
off — oldest first, three per run.

## How to add a task

**Say it.** In any session, say `add a task: chase the Acme invoice` and the team writes
the file for you. That is the normal way.

**Or drop a file by hand.** One file per task, named with the date and a short slug:

```
tasks/2026-08-20-chase-acme-invoice.md
```

## The card format

```markdown
---
status: todo
for: sales
---

Acme's invoice from July is still unpaid. Draft a polite chase email and
note it in the pipeline.
```

| Field | Values | What it means |
|---|---|---|
| `status` | `todo`, `doing`, `done` | `todo` gets picked up by the sweep. `doing` means a run is on it. `done` means finished. |
| `for` | an agent slug, optional | Who should do it. Leave it out and the orchestrator decides. |

The body is the ask, in plain words. Write it the way you would say it to a person.

## What happens to a task

The daily sweep (`workflows/task-sweep.yml`, 09:00 — also a button on your dashboard)
takes the oldest `todo` cards, routes each to the right specialist, and does the work
under that agent's rules: drafts only, nothing sent, published, or spent without you.

When a task finishes, its file stays. The sweep flips `status: done` and appends a
`## Result` section linking the artifact it produced:

```markdown
## Result

Chase email drafted — see `agents/sales/output/2026-08-20-acme-chase.md`.
```

Done cards are your history. Delete one and you delete a piece of it; the run log in
`runs/` still remembers, and the dashboard will show the gap.

## Limits worth knowing

- The sweep stops after **three tasks per run**, so a pile-up can't blow the time
  budget. What was left is named in the sweep digest and picked up next run.
- A card the sweep can't act on (an unknown `for:` agent, an ask it can't do without
  you) stays `todo`, with the reason in the digest.

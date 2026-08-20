# Customer service — workspace

`knowledge/faq.md` is the answer sheet. The agent answers from it and says "I don't know"
when the question is not covered.

`output/` holds one file per ticket: the question, the drafted answer, and whether the FAQ
covered it. Questions the FAQ missed are the list of things worth adding.

## First workflow

This agent arrives running **Weekly Review** (`workflows/weekly-review.yml`) — every
Friday, one page on what the whole team shipped, what slipped, and what went quiet. It is
the orchestrator's review of the week; this agent runs it because the orchestrator lives
in `CLAUDE.md` and is not dispatched directly.

## Operating rules

- **Answers come from the FAQ, or they are "I don't know".** An invented answer to a
  customer question is worse than none.
- **The weekly review is propose-only.** It recommends changes with evidence from the
  week's run logs; it changes nothing itself. Every review ends with "Nothing was
  changed".
- **Silence gets top billing.** An agent or workflow with no runs all week leads the
  review — a worker that quietly stopped is the failure this report exists to catch.

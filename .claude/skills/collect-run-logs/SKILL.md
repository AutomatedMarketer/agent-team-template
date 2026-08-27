---
name: collect-run-logs
description: Gather the facts for the weekly review — every run log from the last seven days, what each agent produced, what failed, and what went silent. Facts only, no judgement yet. Use as the opening step of the weekly review workflow.
audience: team
---

# Collecting the week

The review is only as honest as this step. Gather what actually happened; the writing
step decides what it means.

## 1. Where the facts live

- `runs/<YYYY-MM>/*.json` — one file per run. Filter to the last seven days by the
  timestamp in the filename. A week can span two month folders; check both.
- `inbox/<date>/` — the last seven dated folders. What the workflows actually delivered.
- `agents/<slug>/output/` — anything dated this week that a run produced.

## 2. What to tally

From the run logs, per agent and per workflow:

- **Runs**: how many, with status counts — `ok`, `partial`, `blocked`, `failed`.
- **Failures and blocks**: for each non-`ok` run, the one-line reason from its
  `summary` or `evidence`. Quote the log; do not soften it.
- **Artifacts**: what got produced, from the `artifacts` fields — and whether the file
  is actually there. A log pointing at a missing artifact is itself a finding.
- **Silence**: any agent or scheduled workflow with zero runs this week. Silence is the
  most important row in the whole tally — a worker who quietly stopped looks exactly
  like a worker with nothing to do, until someone counts.

## 3. The evidence rule

Every number in the tally points at a file. If you cannot name the run log or artifact
behind a claim, the claim stays out. An honest "no runs found" beats a plausible
reconstruction of a week that did not happen.

## 4. Hand off

Leave the tally — runs per agent, failures with reasons, artifacts, the silence list —
for the review-writing step. Include the file paths, so the review can link to its
evidence.

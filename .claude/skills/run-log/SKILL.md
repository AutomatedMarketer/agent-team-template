---
name: run-log
description: Write the run-log entry that records what this run did. Use at the end of every agent run, scheduled or manual, before committing.
audience: team
---

# Writing your run log

Every run leaves one record. The cockpit reads these, and so does the person who was
asleep while you worked.

## 1. Collect the facts

```
node scripts/run-facts.mjs <agent> [workflow]
```

One command, every fact below, and the path to write to. It runs the same in PowerShell,
Terminal and bash, so it does not matter which machine you are on.

```
started_at   2026-08-30T14:27:44Z
trigger      manual
session_id   null
session_url  null
run_id       2026-08-30T1427Z-research-morning-intel
path         runs/2026-08/2026-08-30T1427Z-research-morning-intel.json
```

- `session_id` is `CLAUDE_CODE_REMOTE_SESSION_ID`. On a local run it is empty and the command
  prints `null`; write `null`.
- `trigger` reads `CLAUDE_CODE_REMOTE`. The command prints `schedule` for every remote run — if a
  webhook fired this one rather than the clock, write `webhook` instead.
- `finished_at` is the same command run again once the work is done.

## 2. Write the file

Path: `runs/<YYYY-MM>/<run_id>.json`, where `run_id` is `<YYYY-MM-DD>T<HHMM>Z-<agent>`.
If the run executed a workflow, append its slug — `<...>Z-<agent>-<workflow>` — so two
jobs owned by one agent in the same minute never collide. No colon anywhere in the name —
these files are read on Windows. Step 1 builds this name for you and prints it as
`path`, colon-free and with the workflow slug already appended.

If this run executed a workflow (a file in `workflows/`), record which one in a
`workflow` field — its slug, exactly as the filename. The dashboard's Workflows board
matches runs to workflows through this field; without it your workflow shows "never run"
forever, no matter how often it runs. A run that was not a workflow omits the field.

```json
{
  "schema": "run-log/v1",
  "run_id": "2026-08-07T0600Z-research-morning-intel",
  "agent": "research",
  "workflow": "morning-intel",
  "model": "sonnet",
  "trigger": "schedule",
  "started_at": "2026-08-07T06:00:12Z",
  "finished_at": "2026-08-07T06:04:38Z",
  "status": "ok",
  "summary": "Complete sentences, written for someone who saw none of this. Open with what happened.",
  "artifacts": ["agents/research/output/2026-08-07-competitor-pricing.md"],
  "evidence": ["WebSearch returned 11 results", "Wrote 1 file"],
  "next_action": null,
  "session_id": "01J8ZQ2K7N4M",
  "session_url": "https://claude.ai/code/session_01J8ZQ2K7N4M"
}
```

### If the run was graded

A run whose output went through `review-draft` adds one more block. The weekly quality
review counts acceptance from these, so a grade you do not record is a grade that never
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

`verdict` is `passed` or `flagged` - the grader's call. It is not the owner's call; that
arrives later as a verdict in `quality/verdicts/`, and the two disagreeing is the most
useful signal the review produces.

Field meanings are in `runs/README.md`.

## 3. Choose an honest status

| Status | When |
|---|---|
| `ok` | The task finished and you can point to the output |
| `partial` | Some of it finished; say which part did not, in `summary` |
| `blocked` | Something outside your control stopped you — a missing connector, an empty brain |
| `failed` | It broke. Put the error in `evidence`. |

`evidence` holds things a tool returned. If you cannot point at a tool result for a claim,
leave the claim out.

## 4. Check it

```bash
node scripts/validate-run-log.mjs runs/2026-08/2026-08-07T0600Z-research.json
```

Fix anything it reports, then run it again.

**It refuses a field the schema does not have**, rather than dropping it in silence, and for the
names people reach for it says which one you meant - `session_link` for `session_url`, `output`
for `artifacts`, `next_steps` for `next_action`. Do not invent a field to carry extra detail:
nothing reads it, so the detail is lost, and `summary` and `evidence` are where detail belongs.

## 5. Commit the artifact and the log together

```bash
git add agents/research/output/2026-08-07-competitor-pricing.md runs/2026-08/2026-08-07T0600Z-research.json
git commit -m "research: competitor pricing sweep for 2026-08-07"
```

The artifact and the run log go in the same commit. A log with no artifact and an artifact
with no log are both half-records, and the cockpit shows the gap.

If you were told not to commit, do not commit. Leave both uncommitted and say so.
The rule is that the two move together — not that a commit always happens. An agent that
commits over an instruction not to has broken something worse than a half-record.

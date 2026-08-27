---
name: surplus-burn
description: Use-it-or-lose-it quota maximizer. Measures how much of the Claude subscription week is still unspent before the weekly reset and turns the surplus into quality work on the team's existing output - reviews, fixes, efficiency passes, memory and skill hardening. Never busywork. Invoke on demand ("run the surplus burn", "how much quota is left", "burn the surplus") or from a daily scheduled run.
audience: team
---

# Surplus burn - the weekly quota maximizer

Subscription capacity expires at every weekly reset. Unspent capacity on the strongest model
is the most valuable thing a team throws away. So: measure the pace, and when a lot is left
near the reset, tell the owner and spend the surplus making existing work better.

## Step 1 - Measure (deterministic, no judgement)

**Primary - the real limits**, read from the same endpoint the `/usage` screen uses:

```bash
node .claude/skills/surplus-burn/usage-probe.mjs
```

Returns utilization percentages and exact reset timestamps. The OAuth token is read inside
the script and never printed - output is percentages only. If it reports
`no local credentials file`, the machine signs in through a keychain; use the fallback.

**Fallback - a consumption estimate** from local transcripts:

```bash
node .claude/skills/surplus-burn/surplus-check.mjs
```

Figures there are API-cost *equivalents* (the subscription pays $0 per token). Say so
whenever you quote them, and label that verdict "estimated". `config.json` holds this owner's
reset day and hour, written by the install-stack skill at onboarding. If it still says
`null`, stop and calibrate first - a burn measured against someone else's reset is wrong.

**Tier** (remaining = 100 - percent used, hoursLeft from the reset timestamp):

| Tier | Rule |
|---|---|
| HIGH | remaining >= 30% and hoursLeft <= 36 |
| MODERATE | remaining >= 20% and hoursLeft <= 48 |
| NONE | otherwise - write one line to `runs/surplus-burn/log.md` and stop |

## Step 2 - Throttle

- **Target: land at ~98% used by the reset, never over.** Past the cap the account is locked
  until the reset - treat 100% as an outage, not a fee.
- **Hard stop at 95% measured.** Probe readings lag real burn.
- **Probe between every item.** Before starting one, check
  `remaining% > estimated item cost% + 3%`. If it cannot finish inside that margin, take the
  next smaller item instead - a half-done review is worse than an unstarted one.
- Run burn items at low or medium reasoning effort by default. Reserve high effort for the
  single hardest item of the day, chosen on purpose.
- Item sizes: S = 1-2% of the week, M = 3-5%, L = 6-10%. After each item, compare the probe
  delta with the estimate and recalibrate; log the delta.

## Step 3 - Build the burn list (ranked, from live sources)

Gather candidates from, in order:

1. Open cards in `tasks/` and anything marked open in the team's memory.
2. `git log --since='14 days ago' --oneline` - recently touched work is current work.
3. Known debt: the latest `quality/verdicts/`, the last weekly tune-up, security findings.

Rank by value class, highest first:

1. **Correctness** - bugs, failing paths, unverified claims.
2. **Security** - a review of anything changed in the last 14 days.
3. **Automation health** - did every scheduled workflow fire, succeed, and still produce
   correct output? Check the run log, not the schedule.
4. **Skills and connections currency** - recipes in `connections/` still work, plugins in
   `stack.yml` still installed and current.
5. **Efficiency** - simplification passes, dead code, oversized instructions.
6. **Hardening the system** - memory consolidation, skill improvement, writing down what the
   week taught.

Format: a numbered list, each with target, action, size (S/M/L), and which agent or skill
runs it. The strongest model goes to the hardest items; say which items a cheaper model
can handle.

If both the live list and the debt list are genuinely empty: say so and stop. Idle quota
beats fake work.

## Step 4 - Tell the owner

Write the report to `runs/surplus-burn/YYYY-MM-DD.md` and surface it the way the team
surfaces everything else (the daily brief, a task card, a notification if one is wired).
Keep it short: tier, roughly how much of a normal week is unspent, time until reset, the
top three items, and the reply the owner sends back: **"burn 1,3" / "burn all" / "skip today"**.

## Step 5 - Execute, only after the owner replies

- **Green** - reviews, audits, fact-checks, research syntheses: run on "burn".
  Results go to `runs/surplus-burn/`.
- **Yellow** - local fixes: on a branch, with a report. Never straight on main.
- **Red** - pushes, merges, deploys, anything client-facing or that costs money: each one is
  a separate numbered proposal, never bundled into "burn all".
- Every standing gate still applies: the editor grades drafts, nothing sends without a human.

## Step 6 - Close with the return

End every burn session with the comparison, labelled honestly:

- **This week's usage at API prices:** what the tokens would have cost on the API.
- **What was actually paid:** the plan price divided by 4.3 weeks.
- **Multiple:** every $1 of subscription bought $X of model time.
- **This session's share:** how much API-equivalent was reclaimed from quota that would
  have expired.

Log the line to `runs/surplus-burn/log.md` so the multiple is trackable week over week.
Label the figures "API-equivalent" every time - it is not cash saved.

## What this skill never does

- Never invents work to use tokens. An empty list is a valid answer.
- Never runs a red item without an explicit, per-item approval.
- Never treats cost equivalents as real spend when talking to the owner.

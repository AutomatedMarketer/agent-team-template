# Workflows

A **skill** does one task. A **workflow** gets a job done.

That difference is the whole point of this folder. A skill makes you faster. A workflow removes
the moment you had to be there at all — it chains several skills, runs on a schedule or a
button, and writes its result somewhere you will actually find it.

**You never write these files by hand.** Ask for a workflow and one gets built for you:

```
/new-workflow
```

This README exists so you can read what got written, and so the builder has a contract to
follow.

---

## You arrive staffed

Seven workflows ship pre-loaded — one per worker, plus the orchestrator's task sweep —
so every agent owns a working job on day one. Onboarding tailors them to your business;
you edit them by asking.

| File | Owner | When | What it does |
|---|---|---|---|
| `morning-intel.yml` | research | daily 06:30 | What moved in your market overnight |
| `draft-queue.yml` | content | weekdays 07:00 | Your notes, turned into post drafts in your voice |
| `inbox-triage.yml` | email | weekdays 08:00 | Inbox sorted, replies drafted, nothing sent |
| `gone-cold.yml` | sales | weekly mon 09:00 | Who went quiet, chase message drafted |
| `weekly-review.yml` | customer-service | weekly fri 16:00 | What shipped, what slipped, what's gone quiet — propose-only |
| `security-review.yml` | security | weekly mon 07:00 | Anything leaking, anything stale — one report before the week starts |
| `task-sweep.yml` | orchestrator | daily 09:00 | Your `tasks/` cards worked off, three per run, each routed to the right specialist |
| `quality-review.yml` | editor | weekly fri 17:00 | What share of the week's work you used unedited, and what should change |

Every one of them drafts and reports. None of them sends, publishes, or spends.

---

## The shape

```yaml
name: Monday Brief
owner: research
steps: [pull-calendar, scan-inbox, check-pipeline, write-brief]
trigger:
  schedule: "weekly mon 06:00"
  fire: true
output: inbox/{date}/monday-brief.md
```

| Field | Required | What it means |
|---|---|---|
| `name` | yes | What it is called on the dashboard |
| `owner` | yes | Which agent runs it. Must be an agent in `.claude/agents/` — a specialist, or `orchestrator` for cross-team jobs like the task sweep |
| `steps` | yes | The skills it runs, in order. Inline `[a, b]` or a dashed list — both work |
| `trigger` | yes | At least one of `schedule`, `fire`, `webhook` |
| `output` | yes | Where the result lands. Must stay inside the repo |
| `done` | no | What good looks like - `looks_like`, `must_have`, `never`. The grader marks against it. See `shared/standards/definition-of-done.md` |
| `runner` | no | `routine` (default) or `github-actions` |

## Triggers

- **`schedule`** — it runs on its own. See the forms below.
- **`fire: true`** — it gets a button on your dashboard, so you can start it from your phone.
- **`webhook: true`** — an outside system can start it. See `docs/webhook-contract.md`.

You can have all three on one workflow. Most useful workflows have a schedule *and* a button:
it runs Monday morning whether you are there or not, and you can also run it on demand.

## Schedule forms

Written the way you would say them. No cron.

| Form | Example |
|---|---|
| `hourly` | `hourly` |
| `daily HH:MM` | `daily 06:00` |
| `weekdays HH:MM` | `weekdays 09:30` |
| `weekly <day> HH:MM` | `weekly mon 06:00` |
| `monthly <date> HH:MM` | `monthly 1 08:00` |
| `every N minutes\|hours` | `every 2 hours` |

Times are 24-hour and zero-padded — `06:00`, not `6:00`.

## The one-hour floor, and how to get under it

**Routines will not run more often than once an hour.** That is not our rule, it is how
scheduled cloud runs work. A workflow set to `every 10 minutes` on the default runner is
rejected at validation rather than quietly never firing — which is the version of this problem
that costs you a week before you notice.

If you genuinely need it faster, change the runner:

```yaml
runner: github-actions
trigger:
  schedule: "every 10 minutes"
```

GitHub Actions has no hourly floor and no daily cap, it is free, and it bills your Claude
subscription rather than per-token API usage. Setup is one command — `/install-github-app`.

## Why one workflow instead of four scheduled skills

Scheduled cloud runs are capped per day — roughly five on Pro, fifteen on Max. **The cap counts
runs, not work.** A Monday Brief that chains four skills costs you one run out of five, not
four. Chaining is not a tidiness preference; it is what keeps you inside the cap.

## Where the output goes

`output` accepts `{date}`, which becomes `YYYY-MM-DD` at run time. Sending results to
`inbox/{date}/…` is the default for a reason: every filename is unique, so two machines and a
cloud run can never collide, and syncing across your laptop, your travel machine and the cloud
stays conflict-free by construction.

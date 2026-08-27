---
name: watch-updates
description: Check the team's installed skills and the upstream product repos for changes since the last run, diff against the last-seen note, and report what moved. Use as the second step of the security review workflow.
audience: team
---

# Watching for updates

The question this step answers: **has anything this team depends on changed since we
last looked?** A team running on last month's tooling misses fixes it was already given.
You detect and report — updating anything is the owner's call.

## 1. Load the watch list and the last-seen note

- `agents/security/knowledge/watch-list.md` — what to watch. If it still contains
  `<!-- fill: ... -->` markers, watch the three upstream repos it names and say in your
  notes that the list was otherwise empty.
- `agents/security/output/last-seen.md` — where each watched thing stood at the end of
  the previous run. First run ever? No note is normal: record today's state, report
  "baseline established", and skip the diffing below.

## 2. Check the installed skills

List the folders under `.claude/skills/` and compare against the last-seen note:

- Skills added or removed since last run.
- Skills whose `SKILL.md` changed — compare the file's last commit date to the note.

A new skill nobody remembers installing is a finding, not just a diff line.

## 3. Check the upstream repos

For each upstream repo in the watch list — the product ships from these three public
GitHub repos:

- `github.com/AutomatedMarketer/agent-team-template`
- `github.com/AutomatedMarketer/agent-team-os`
- `github.com/AutomatedMarketer/agent-cockpit`

fetch the repo's releases page (or, when a repo cuts no releases, its commit list) and
note the newest release tag or commit date. Compare with the last-seen note:

- **Newer than last seen** — summarise what changed in one or two lines per release,
  oldest first, from the release notes. Flag anything that mentions security, breaking
  changes, or new checks.
- **Same as last seen** — one line: up to date.
- **Unreachable** — say so and keep the old marker; a failed fetch is not "no news".

## 4. Refresh the last-seen note

Rewrite `agents/security/output/last-seen.md` with today's state — one line per watched
item: what it is, the marker you saw (tag, commit date, or skill list), and today's
date. This file is yours; it is the only thing this skill ever writes outside the
report, and it lives in your own output folder.

## 5. Hand off

Leave your findings — what moved, what it means for this team, and whether the owner
should ask their team to pull the update — for the report step. Recommend, do not
update: pulling upstream changes is a change to the team, and changes wait for approval.

## What the output looks like

Your section of the run's report reads like this:

```markdown
## Updates upstream

- **agent-team-template** — new release `v1.4` (was `v1.3`): adds a stricter secrets
  test. Worth pulling; ask your team to "update from the template" when ready.
- **agent-team-os** — up to date.
- **agent-cockpit** — up to date.
- **Installed skills** — no additions, no removals, no edits since last run.

Last-seen note refreshed: agents/security/output/last-seen.md
```

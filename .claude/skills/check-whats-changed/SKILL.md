---
name: check-whats-changed
description: Check whether the models, the product changelogs, and the connectors this team depends on have moved since last week, and report what it means for this team. Detect and report only. Use as the first step of the weekly tune-up.
---

# Checking what moved

A team quietly running on last quarter's assumptions is the most expensive failure in this
repo, because nothing looks broken. This step asks one question every week:

> **Is anything this team runs on no longer true?**

You **detect and report. You do not change how the team is wired.** Swapping a model,
pulling an upstream change, or re-authorising a connector are all the owner's calls, and
they arrive as task cards, not as edits you made.

## What this step does not cover

`watch-updates` — the second step of the security review — already watches the installed
skills and the three product repos. Do not repeat that work here. If the security review has
not run in over two weeks, say so in one line and move on; a watcher that stopped watching
is itself a finding.

## 1. Load the last-checked note

`agents/orchestrator/output/last-checked.md` holds where each item stood last Sunday. No
note? That is a normal first run: record today's state, report **"baseline established"**,
and skip every comparison below.

## 2. The four lanes

### Lane 1 — models

The repo names `opus` and `sonnet` as **aliases, never pinned ids**, exactly so this lane
rarely produces work. So check the two things that actually rot:

1. **Has a new model tier or generation shipped?** If so, say what changed about the
   trade-off, and whether any agent's row in `shared/standards/model-card.md` now looks
   wrong. Do not change the card.
2. **Has a pinned id crept into the repo?** Grep for one. A pinned id is a finding every
   time, because it is a file that will silently rot:

```bash
grep -rn "claude-[a-z]*-[0-9]" --include=*.md --include=*.mjs --include=*.json . | grep -v node_modules
```

### Lane 2 — the product changelogs

Read the changelog for each tool the team's work actually depends on — Claude Code first,
then anything else in the watch list. Compare against the last-checked marker.

Report only what **changes how this team should work**: a new capability that would replace
something the team does by hand, a behaviour change that breaks an assumption in a skill, a
deprecation with a date on it. Skip everything else. A tune-up report that lists forty
release notes is a report nobody reads twice.

### Lane 3 — connectors

`connections/register.yml` is the list — every connection `/connect` has proved, with the
account it uses and the workflows that depend on it. Cross-check it against
`.claude/settings.json`, `.mcp.json` if present, and the names in `.env.example`:

| Check | What a finding looks like |
|---|---|
| Still authorised | An expired login is the most common cause of a workflow that "just stopped working" |
| Still reachable | A dead endpoint, reported before a scheduled run hits it at 6am |
| Configured but unused | Named in config, referenced by no skill or workflow. Attack surface with no benefit |
| Used but not configured | A skill calls something the repo cannot reach. This one is urgent |

Also report any recipe in `connections/recipes/` whose `verified` date is more than 90 days
old. Connection details change monthly, and a stale recipe is a step-by-step guide to a page
that has moved.

**Never print a key, a token, or a URL containing one.** Report the connector by name and
its state. If you cannot test a connector without spending money or sending something,
do not test it — say it was not tested and why.

### Lane 4 — what the team leverages

Anything in `runtimes.yml`, plus any GitHub repo a skill in this repo tells the team to use.
Newest release or commit date against the last-checked marker, one line each.

An **unreachable** item keeps its old marker and is reported as unreachable. A failed fetch
is never "no news" — that is how a watcher goes blind without anyone noticing.

## 3. Refresh the note

Rewrite `agents/orchestrator/output/last-checked.md`: one line per watched item — what it
is, the marker you saw, today's date. This note and the report are the only things this
step writes.

## 4. Hand off

Pass to `learn-from-the-week`: what moved, what it means for this team, and which findings
deserve a card. Recommend; never rewire.

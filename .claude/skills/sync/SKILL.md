---
name: sync
description: Bring this machine level with the repo and push anything done here. Use at the start of a session, at the end of a session, and any time you are about to switch machines.
---

# Sync

Your team lives in one repo. Your laptop, your travel machine and every cloud run are copies of
it. Sync is how they stay the same thing.

**You should never type a git command.** Ask for a sync, or let it run at the start and end of a
session.

## 1. Come level before you start

```bash
git pull --rebase --autostash
```

`--rebase` keeps the history a straight line instead of a thicket of merge commits.
`--autostash` sets aside anything half-finished, pulls, and puts it back.

If the pull reports a conflict, **stop and say so in plain words** — which file, and what the
two versions each say. Do not resolve it silently. Conflicts should be close to impossible
here (see below), so one appearing means something is worth a human look.

## 2. Push what happened here

```bash
git add -A
git status --short
```

Read the list before committing. Two things must be true:

- **No `.env`, no keys, no tokens.** They are gitignored, but check the list anyway. If a
  credential is staged, remove it, tell the user, and treat it as compromised.
- **Nothing surprising.** If files you did not touch are staged, find out why before pushing.

Then commit with a message that says what actually changed, and push:

```bash
git commit -m "<what changed, in a sentence>"
git push
```

If there is nothing to commit, say so and stop. An empty sync is a normal outcome.

## 3. Why conflicts are rare by design

Agents only ever write to `inbox/<date>/<agent>-<timestamp>.md` and `runs/<month>/<id>.json`.
Every one of those filenames is unique to the run that made it, so **two machines cannot write
the same file**. There is nothing to merge.

Files a human edits — `shared/`, `CLAUDE.md`, `tiles.yml` — are the only place a genuine
conflict can occur, and only if you edit the same one on two machines without syncing between.
Syncing at the start of a session is what prevents that.

## 4. What does not sync, and why

| Not synced | Why |
|---|---|
| `.env` | Secrets never enter the repo. Cloud runs read theirs from the environment instead |
| `node_modules/` | Rebuilt, never carried |
| Anything in `.gitignore` | Same reason it is ignored |

**If a cloud run cannot see something, it is because that thing is not in the repo.** That is
the single most common cause of a scheduled workflow failing on its first run: the key that
works on your laptop was never there to find.

## 5. Travelling

- **On a phone** — nothing to sync. The dashboard and your scheduled work run in the cloud
  against the repo directly.
- **On a borrowed or second machine** — clone the repo, work, sync at the end.
- **Going offline** — sync before you go. Work locally. Sync when you land.

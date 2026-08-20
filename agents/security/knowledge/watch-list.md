# Watch list

The security agent audits the repo this file lives in, and watches everything listed
below for upstream changes. Edit this file freely — it is yours.

## Your repo

<!-- fill: watch-own-repo-name -->

Anything about your repo the auditor should know — folders that are supposed to hold
large files, credentials that are placeholders on purpose, paths to skip:

<!-- fill: watch-own-repo-notes -->

## Upstream repos

The product ships from these. The agent checks each for new releases or commits since
its last run and keeps its own last-seen marker in `agents/security/output/last-seen.md`.

| Repo | Why it is watched |
|---|---|
| `github.com/AutomatedMarketer/agent-team-template` | The template your team was built from — updates here are fixes you can pull. |
| `github.com/AutomatedMarketer/agent-team-os` | The operating system layer — new skills and packs land here. |
| `github.com/AutomatedMarketer/agent-cockpit` | The cockpit that reads your run logs — schema changes matter to every run. |

## Anything else you want watched

Add a row per item — a tool your team shells out to, a dependency, a service status page:

| What | Where to check | Why |
|---|---|---|
| <!-- fill: watch-extra-1 --> | | |
| <!-- fill: watch-extra-2 --> | | |

---
name: scan-repo-security
description: Sweep this repo for accidentally committed secrets, tracked .env files, oversized junk, and risky workflow permissions — read-only, findings ranked by severity. Use as the opening step of the security review workflow.
audience: team
---

# Scanning the repo

The question this step answers is narrow: **is there anything in this repo, or in its
history, that would hurt the owner if a stranger read it or ran it?** You look, you rank,
you report. You change nothing.

## 1. Secrets in tracked files

Sweep every tracked text file for things that behave like credentials:

- Values assigned to names like `password`, `secret`, `api_key`, `access_key`, or
  `webhook` — where the value is a real-looking string, not a blank or a placeholder.
- Vendor-prefixed keys: long strings opening with a known issuer prefix (GitHub, cloud
  providers, payment processors, model providers all use recognisable prefixes).
- Private key blocks — the five-dash `BEGIN ... KEY` header is unmistakable.
- Connection strings that embed a username and password in a URL.

A placeholder is fine: an empty value, `your-key-here`, or an `<!-- fill: ... -->`
marker is the repo working as designed. Judge the value, not the variable name.

**When a hit is real, treat the credential as compromised.** Record the file, the line
number, and the kind of credential — never the value itself. The proposed fix is: the
owner rotates it at the issuing service, then removes it from the file. Rotation comes
first, because deleting the line does not un-leak the history.

## 2. Secrets in git history

A secret deleted last month is still one `git log -p` away. Check whether any `.env`
file, key file, or previously flagged path ever appears in history:

```bash
git log --all --pretty=format: --name-only | sort -u
```

Anything credential-shaped that shows up only in history is still a finding — lower
urgency than a live file, same instruction: rotate first.

## 3. Tracked files that should be ignored

- `.env` or any `.env.*` other than `.env.example` in `git ls-files` output.
- Whether `.gitignore` actually contains the `.env` and `.env.*` lines, with
  `!.env.example` re-included.

## 4. Oversized and binary junk

```bash
git ls-files | while read f; do du -k "$f"; done | sort -rn | head -20
```

Flag anything over about 1 MB that is not clearly a deliberate asset: node_modules that
slipped in, database dumps, videos, build output. The proposed fix names the file and
suggests ignoring or removing it — proposing, not doing.

## 5. Risky workflow permissions

Read every file under `.github/workflows/` if the folder exists:

- `permissions: write-all`, or write permissions a job's steps do not use.
- `pull_request_target` combined with a checkout of the incoming branch.
- Steps that `echo` a secret, or pass one on a command line where it lands in logs.
- Third-party actions pinned to a floating tag on a job that holds write access.

No workflows folder is a one-line note, not a problem.

## 6. Rank and hand off

Rank every finding: **critical** (a live secret, or a workflow a stranger can make run
their code), **high** (tracked `.env`, secret in history), **medium** (over-broad
permissions, large junk), **low** (hygiene). State the reason for each rank.

Leave your ranked findings — one numbered entry per finding, each with location, why it
matters, and the proposed fix — for the next step in the chain.

## What the output looks like

Your section of the run's report reads like this:

```markdown
## Repo hygiene — 2 findings

1. **[critical] Live credential in `scripts/notify.sh` line 12** — a vendor key is
   assigned to `WEBHOOK_KEY`. Treat it as compromised: rotate it at the issuing
   service, then move the reference to `.env`. The value is not reproduced here.
2. **[medium] `assets/demo.mov` is 48 MB** — bloats every clone. Proposed fix: remove
   it and link the hosted copy instead.

Checked: tracked files, git history, .gitignore coverage, file sizes, workflow
permissions. Everything not listed above came back clean.
```

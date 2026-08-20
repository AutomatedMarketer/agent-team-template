# Security — workspace

`output/` holds one dated review per run, plus `last-seen.md` — the agent's own record
of where each watched repo and skill stood at the end of its previous run. `knowledge/`
holds the editable watch list.

## First workflow

This agent arrives owning **Security Review** (`workflows/security-review.yml`) — a
weekly sweep of the repo plus an upstream update check, in `inbox/` Monday morning.

## Operating rules

- **Read-only, and it stays that way.** The agent proposes fixes; it applies none of
  them. Approving a finding is a person's job.
- **A live secret is reported as compromised** — location and kind only, never the
  value — with the instruction to rotate it at the issuing service.
- **Findings are ranked by severity**, worst first, so the report is readable in the
  order it matters.
- **A clean week is still a report.** "Nothing found" tells you the check ran.

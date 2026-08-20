# Research — workspace

`output/` holds one dated markdown report per run: what was asked, what was found, and a
live source URL for every claim.

## First workflow

This agent arrives owning **Morning Intel** (`workflows/morning-intel.yml`) — what moved
in your market overnight, in `inbox/` before your first call.

## Operating rules

- **Every claim carries a link and a date.** A finding without a source does not go in a
  report.
- **Anything unconfirmed is marked `[unverified]`** — or left out. It is not promoted to
  fact by being written down.
- **Recent beats thorough.** Sources from the last six months are preferred; anything
  older gets its date shown next to it.
- **A thin result is reported thin.** When the web turns up nothing useful, the report
  says so instead of padding.

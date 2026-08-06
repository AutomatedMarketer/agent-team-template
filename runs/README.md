# runs/ — what your team did, and when

Every run writes one file here. One file per run, never a shared log, so two agents that
finish in the same minute can never overwrite each other.

    runs/2026-08/2026-08-07T0600Z-research.json

The folder is the month. The filename is the `run_id`. Both are safe on Windows — there
is no `:` anywhere.

## The record

```json
{
  "schema": "run-log/v1",
  "run_id": "2026-08-07T0600Z-research",
  "agent": "research",
  "model": "sonnet",
  "trigger": "schedule",
  "started_at": "2026-08-07T06:00:12Z",
  "finished_at": "2026-08-07T06:04:38Z",
  "status": "ok",
  "summary": "Checked what four competitors are charging and found three raised prices since May. Full comparison with a source link per number is in the report linked below.",
  "artifacts": ["agents/research/output/2026-08-07-competitor-pricing.md"],
  "evidence": ["WebSearch returned 11 results", "Fetched 4 pricing pages", "Wrote 1 file"],
  "next_action": null,
  "session_id": "01J8ZQ2K7N4M",
  "session_url": "https://claude.ai/code/session_01J8ZQ2K7N4M"
}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Always `run-log/v1`. Bump it and the cockpit knows to read differently. |
| `run_id` | string | `YYYY-MM-DDTHHMMZ-<agent>`. Equals the filename without `.json`. |
| `agent` | string | One of `research`, `content`, `email`, `customer-service`, `sales`. |
| `model` | string | `opus` or `sonnet`. An alias, never a pinned id. |
| `trigger` | string | `schedule`, `webhook`, or `manual`. |
| `started_at` | string | ISO instant ending in `Z`. |
| `finished_at` | string | ISO instant ending in `Z`. |
| `status` | string | `ok`, `partial`, `blocked`, or `failed`. |
| `summary` | string | Complete sentences, at least 40 characters, no arrow chains. Written for someone who saw none of the work. |
| `artifacts` | string[] | Repo-relative paths the run produced. |
| `evidence` | string[] | Things a tool actually returned. Not claims. |
| `next_action` | string or null | What a person has to do next, if anything. |
| `session_id` | string or null | `CLAUDE_CODE_REMOTE_SESSION_ID`. Null only on a local manual run. |
| `session_url` | string or null | `https://claude.ai/code/session_<session_id>`. Null only on a local manual run. |

## Checking a file

    node scripts/validate-run-log.mjs                       # every run log
    node scripts/validate-run-log.mjs runs/2026-08/x.json   # one of them

## Why the cockpit can read this

It lists `runs/`, parses each JSON file, sorts by `started_at`, and renders. No special
cases, no API, no database. Your history is in git and it is yours.

# Pipeline

The sales agent appends one row per prospect. This is your CRM until you have one.

| Date | Prospect | Source | Stage | Last action | Next action | Why | Research file |
|---|---|---|---|---|---|---|---|

## What the columns mean

| Column | What goes in it |
|---|---|
| `Date` | When the row was first added. It does not change. |
| `Prospect` | The company. The name you would say out loud, not the legal entity. |
| `Source` | Where the prospect came from — a referral, a list, a search, "owner request". Not where the research came from; that is the research file. |
| `Stage` | One of the values below. Nothing else. |
| `Last action` | What was actually done, and when. |
| `Next action` | What happens next, and when. Empty is fine on a closed row. |
| `Why` | The reason behind the stage. On a `Skipped` row this is the column that matters. |
| `Research file` | Link to the prospect file in this folder. |

## Stage — the only permitted values

The weekly pipeline review reads these to work out who has gone quiet, so a stage it does not
recognise makes that prospect invisible. Use exactly these:

| Stage | Means | The review treats it as |
|---|---|---|
| `Researched` | Looked at, fits, no message written or sent yet | Active — needs a first message |
| `Skipped` | Researched and deliberately not pursued. Reason goes in `Why` | Closed. It stays skipped and is never chased |
| `Approached` | A message has gone out, no reply yet | Active — the clock for "gone quiet" starts here |
| `Replied` | They answered | Warm, whatever the date says. Never counted as cold |
| `Cold` | Approached, no reply, follow-up window passed | Chase candidate |
| `Closed` | Finished either way — won, lost, or no longer relevant. Put which in `Why` | Closed |

**`Skipped` is not a failure state.** A prospect you correctly declined to chase is the
cheapest row in this file.

---
name: review-pipeline
description: Read the sales pipeline and find who has gone quiet — prospects contacted but not answered, past the follow-up window. Reads records before judging them; invents nothing. Use in the gone-cold and weekly review workflows.
---

# Reviewing the pipeline

The pipeline is `agents/sales/output/pipeline.md` unless a CRM is connected. Either way
the job is the same: who did we approach, who answered, and who has gone quiet.

## 1. Read before you judge

Three rules, in force whether the pipeline is a markdown table or a connected CRM:

- **Fetch the record before you assess it.** A prospect's row — or CRM record — gets
  read in full before you call them cold. Judging from a remembered summary is how a
  prospect who replied yesterday gets a chase message today.
- **Nothing gets invented.** No fabricated contact details, dates, deal sizes, or
  record IDs. A field the record does not contain stays blank in your output.
- **Anything outward-facing waits for a yes.** This step reads and reports. Updating a
  CRM record, and anything that touches the prospect, sits behind a person's approval.

## 2. What "gone quiet" means

A prospect is cold when all three hold:

1. We reached out — there is a logged approach in their row.
2. They have not replied — no logged response since.
3. The follow-up window has passed — use the follow-up date in their row when there is
   one, and 7 days since last touch when there is not.

A prospect we said we would skip stays skipped. A prospect with a reply logged is warm,
whatever the date says.

## 3. What leaves this step

A list, coldest first — for each quiet prospect: name, what we last sent and when, the
follow-up note from their research file (`agents/sales/output/<date>-<prospect>.md`)
when one exists, and anything in the row that suggests why they went quiet.

Also note pipeline health in two lines: how many rows total, how many active, how many
cold. The weekly review reads this step's output too, so write it to be read twice.

If the pipeline is empty or has no cold rows, say so in one line. An empty chase list is
a fine result; a padded one costs the owner real relationships.

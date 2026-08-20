# Sales — workspace

`knowledge/offer-sheet.md` is what you sell and for how much.

`output/pipeline.md` is your CRM until you have one — a table the agent appends a row to
for every prospect it researches. `output/` also holds one research-and-outreach file per
prospect.

## First workflow

This agent arrives owning **Gone Cold** (`workflows/gone-cold.yml`) — every Monday, who
in the pipeline went quiet and a chase message drafted for each.

## Operating rules

Three rules, and they hold whether the pipeline is this markdown file or a connected
CRM:

- **Read the record before acting on it.** A prospect's full row gets fetched before any
  judgement or update — working from memory is how someone who replied yesterday gets
  chased today.
- **Anything that reaches a prospect waits for your yes.** Messages stay in drafts;
  record changes in an external CRM wait for approval. The agent researches and drafts;
  you send.
- **Nothing is invented.** No made-up contact details, deal sizes, dates, or record IDs.
  A field the record does not have stays blank.

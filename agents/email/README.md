# Email — workspace

`output/` holds the triage summary for each sweep: what arrived, what was archived, what
needs you. The replies themselves live in your Gmail drafts folder, not here.

## First workflow

This agent arrives owning **Inbox Triage** (`workflows/inbox-triage.yml`) — every
weekday morning, your inbox sorted and your replies drafted.

## Operating rules

- **Three buckets, exactly one per message:** *needs a person*, *needs a reply it can
  draft*, or *noise*. A message it cannot place goes to *needs a person* — uncertainty
  rounds up.
- **It never sends.** Not replies, not forwards — nothing, on any run. Every draft waits
  in your drafts folder for you to read and send. Each sweep summary ends with the line
  "Nothing was sent", and it is true because sending is not something this agent does.
- **Urgent mail gets flagged, not answered.** A message demanding an immediate response
  goes to the top of *needs you*; that is what urgency gets from an assistant.

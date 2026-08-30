# Routing

Three steps, in order. Stop at the first one that matches.

1. **Does a skill in `.claude/skills/` already do this?** Use it.
2. **Does one specialist own this domain?** Delegate to it with the `Task` tool, naming
   the agent by its slug.
3. **Does it need more than one specialist?** Match a pattern below, run the
   data-gathering step first, then the writing step.

If none of the three fits and the job takes a handful of tool calls, do it yourself.

## Who owns what

| Request sounds like | Specialist |
|---|---|
| "What are competitors charging?" · "Look up this company" · "What is happening in X?" | `research` |
| "Write me a post" · "Draft this week's newsletter" · "Turn this into a caption" | `content` |
| "What is in my inbox?" · "Reply to these" · "Clear out the noise" | `email` |
| "A customer asked X" · "Answer this support ticket" | `customer-service` |
| "Research this prospect" · "Write the outreach" · "Where is this deal?" | `sales` |
| "Is anything secret sitting in our repo?" · "Are our tools out of date?" · "Run a security check" | `security` |
| "Is this good enough to send?" · "Mark this against the rubric" · "How much of last week did I actually use?" | `editor` |
| "Is anything out of date?" · "Are my connectors still working?" · "What did we get wrong this week?" | `orchestrator` |
| "Connect my [tool]" · "Can it read my inbox yet?" · "Hook it up to my store" | the `connect` skill - step 1 of routing, before any specialist |

## Multi-specialist patterns

### Prospect to outreach
1. `research` — who this company is, what they sell, recent signals
2. `sales` — outreach draft using those findings, logged to `agents/sales/output/pipeline.md`

### Research to content
1. `research` — the sourced report
2. `content` — turn the report into posts in the student's voice

### Anything a person will read
1. the specialist that owns the craft - the draft
2. `editor` - marked against `shared/standards/rubrics/<craft>.md` before it reaches the owner

Never let a specialist grade its own work. It already knows what it meant, so it reads the
intention rather than the words.

### Inbox to reply
1. `email` — triage and identify what needs a human answer
2. `content` — only when the reply is public-facing and needs voice work

## When a specialist has no data

Say what was missing, do the part you can, and put the gap in the run log's
`next_action` field. Inventing a business the student does not have is worse than an
honest gap.

## When a specialist is not in use at all

Different case, and do not treat it as the one above. If a specialist's knowledge file says in
words that it does not apply to this owner - `agents/sales/knowledge/offer-sheet.md` saying
*"I do not sell"*, `agents/customer-service/knowledge/faq.md` saying *"I do not deal with
customers"* - then it is off by decision, not empty by accident. Common for someone who works
for the business rather than owning it.

**Do not route to it, and do not write a `next_action` telling them to fill the file in.** Say
which specialist the request would have gone to, quote the line that says it is not in use, and
offer the nearest thing the team *can* do. A `next_action` that asks for something the owner has
already decided against is how a run log stops being read.

Read the knowledge file before routing, not after the specialist has started.

# Routing

Three steps, in order. Stop at the first one that matches.

1. **Does a skill in `.claude/skills/` do the whole job on its own?** Use it.
   **Skip any skill whose description says it is the opening or closing step of a workflow.**
   Half this repo's skills say exactly that - `scan-market` is *"the opening step of the morning
   intel workflow"*, `draft-content-queue` *"the closing step of the draft queue workflow"* - and
   a chain fragment is not a job. Those belong to step 3, or to the workflow that owns them.
2. **Does one specialist own this domain?** Delegate to it with the `Task` tool, naming
   the agent by its slug.
3. **Does it need more than one specialist?** Match a pattern below, run the
   data-gathering step first, then the writing step.

If none of the three fits and the job takes a handful of tool calls, do it yourself.

**Then, whatever matched: anything a person outside the team will read goes to `editor` before
it reaches the owner.** This is not a fourth step you can stop before - it applies on top of
whatever step 1, 2 or 3 produced. *"Write me a post"* stops at step 2 with `content`, and the
draft still goes through `editor`. Read literally without this line, the stop rule cancelled the
quality gate for every single-specialist job, which is most of them.

## Who owns what

**Seven specialists, and you delegate to all seven.** Everything in this table is an agent in
`.claude/agents/` that takes work handed to it.

| Request sounds like | Specialist |
|---|---|
| "What are competitors charging?" · "Look up this company" · "What is happening in X?" | `research` |
| "Write me a post" · "Draft this week's newsletter" · "Turn this into a caption" | `content` |
| "What is in my inbox?" · "Reply to these" · "Clear out the noise" | `email` |
| "A customer asked X" · "Answer this support ticket" | `customer-service` |
| "Research this prospect" · "Write the outreach" · "Where is this deal?" | `sales` |
| "Is anything secret sitting in our repo?" · "Are our tools out of date?" · "Run a security check" | `security` |
| "Is this good enough to send?" · "Mark this against the rubric" · "How much of last week did I actually use?" | `editor` |

**Two things that used to sit in that table and are not specialists.** Both were in the
Specialist column, so a reader scanning for *who does this* got a skill and a router.

- **`connect` is a skill, not an agent.** *"Connect my [tool]"*, *"can it read my inbox yet?"*,
  *"hook it up to my store"* is caught at **step 1** and never reaches a specialist.
- **The orchestrator is you, the front door.** *"Is anything out of date?"*, *"are my connectors
  still working?"*, *"what did we get wrong this week?"* are the front door's own work - they run
  as scheduled jobs and land back here. **Do not delegate them to `orchestrator`.** Nobody routes
  work to the front door, and `.claude/agents/orchestrator.md` says so in as many words: *"nobody
  routes work 'to' you"*. Routing to it was this file contradicting that one.

## Multi-specialist patterns

### Prospect to outreach
1. `research` — who this company is, what they sell, recent signals
2. `sales` — outreach draft using those findings, logged to `agents/sales/output/pipeline.md`

### Research to content
1. `research` — the sourced report
2. `content` — turn the report into posts in the student's voice

### Anything a person will read - applies on top of whatever routed above
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

**Not in use governs work, not safety.** If the owner addresses a specialist directly to check
that it refuses something - *"Sales: send the outreach"*, the safety pass every course teaches -
**hand it to that specialist and let it answer as itself.** Do not intercept with "sales is not
in use": that turns a switched-off agent into two-fifths of a safety check nobody ran, and the
whole point of the pass is watching the refusal happen rather than trusting that the sentence is
still in the file. An agent that is off still has to say no when reached.

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

## Multi-specialist patterns

### Prospect to outreach
1. `research` — who this company is, what they sell, recent signals
2. `sales` — outreach draft using those findings, logged to `agents/sales/output/pipeline.md`

### Research to content
1. `research` — the sourced report
2. `content` — turn the report into posts in the student's voice

### Inbox to reply
1. `email` — triage and identify what needs a human answer
2. `content` — only when the reply is public-facing and needs voice work

## When a specialist has no data

Say what was missing, do the part you can, and put the gap in the run log's
`next_action` field. Inventing a business the student does not have is worse than an
honest gap.

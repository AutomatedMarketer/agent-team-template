# Webhook contract — customer service

## Why this exists

Routines carry a one hour minimum interval, so the fastest a scheduled agent can react is
60 minutes. A customer who fills in a form and waits an hour for a reply has already formed
an opinion. The webhook removes the wait: the form posts straight to the routine, and the
agent starts in seconds.

This is the only place in the course where an outside system reaches into the team, and it
is what makes the setup feel professional rather than hobbyist.

## The request

The student's form, help desk, or site posts to the routine's fire endpoint. The URL is
issued per routine in `claude.ai/code` and belongs to the student — it is never written
into this repo, and never committed anywhere.

```
POST <the fire URL for this student's customer-service routine>
Content-Type: application/json
```

```json
{
  "ticket_id": "web-2026-08-07-0043",
  "channel": "form",
  "from": "someone@example.com",
  "received_at": "2026-08-07T14:22:10Z",
  "question": "Do you offer a refund if it doesn't work for my business?"
}
```

| Field | Required | Meaning |
|---|---|---|
| `ticket_id` | yes | Anything unique. Becomes part of the output filename. |
| `channel` | yes | `form`, `email`, or `manual`. Recorded in the ticket file. |
| `from` | yes | Who asked. An address or a name. |
| `received_at` | yes | ISO instant ending in `Z`. |
| `question` | yes | Their words, unedited. |

## What the agent does with it

It reads `agents/customer-service/knowledge/faq.md`, drafts a reply, writes one file to
`agents/customer-service/output/`, writes a run log with `trigger` set to `webhook`, and
commits both — unless you told it not to, in which case it leaves both uncommitted and
says so. It does not reply to the customer. A person sends the draft.

## Keeping the URL safe

The fire URL is the one thing here that acts like a credential — anyone holding it can
start a run on the student's account. It lives in the form tool's configuration, not in
this repo, not in an environment variable, and not in a screenshot.

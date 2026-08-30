---
name: connect
description: Connect one tool to the team, end to end - work out how it connects, wire it, prove it with a real read of the owner's own data, register it so the dashboard shows it, and write the recipe so the next person does not have to research it again. Use whenever the owner wants to add a tool, or when a workflow is blocked because something is not connected.
audience: team
---

# Connecting a tool

This is the step where most people give up, so it is the step that has to be done for them.

## The promise, and its one hard limit

> **You click "sign in". I do everything else.**

That limit is real and never bends: a sign-in happens in **their** browser, on **their**
account. You never see, ask for, or hold a credential. Say the promise in those words at the
start, because the thing they are bracing for is a wall of setup instructions.

## The rules

1. **One connection per session.** Never batch. A batch fails halfway and the owner cannot
   tell which half.
2. **It is not connected until it returns their own data.** A green tick with no read behind
   it is the single most damaging thing you can produce here — it moves the failure to 6am
   on a Tuesday inside a scheduled run.
3. **Read-only to prove it.** Never write, send, post, or spend to verify a connection.
4. **Never research from memory.** Connection details change monthly. Look them up, and say
   when you looked.
5. **Ask whose account it is before wiring anything they did not sign up for themselves.**
   A work Google or Slack account is administered by someone else: they may not be permitted to
   grant access, the admin can revoke it without telling them, and the data behind it is their
   employer's rather than theirs. If it is a work account, say so plainly, offer a personal one
   for the course exercises, and **do not connect it while the question is open**. Every other
   failure in this skill is recoverable by clicking again; this one is not.

## 1. Show them where they stand

Read `connections/register.yml` and say it plainly — what is connected, what is not, and
what is registered but has not answered lately. Then ask one question:

> "What do you want your team to be able to reach that it cannot reach today?"

If they name several, pick the one that unblocks a workflow they already have, and say why
you are starting there. The others go on the list.

## 2. Work out which tier this is

| Tier | When | What you do |
|---|---|---|
| **1 · Universal** | Gmail, Google Calendar, Google Drive | The known path. No research needed |
| **2 · Recipe** | `connections/recipes/<slug>.md` exists | Follow the recipe. Check its `verified` date; over 90 days old, re-check the one step that names a URL or a package |
| **3 · New** | No recipe | Research it, wire it, then **write the recipe** |

Tier 1 exists because everyone has it and nothing about it is interesting. Tier 3 is the
real job — nobody's stack is the catalogue.

## 3. Tier 3 — research before you touch anything

Sources, in this order. Say which one you used and the date you read it:

1. **Context7**, if it is available in this session — `resolve-library-id` then `query-docs`.
   Official, versioned docs beat everything else.
2. **The vendor's own docs** — their MCP page, developer docs, or CLI reference. Fetch them.
3. **A dated web search**, restricted to the **last 90 days**. Anything older is a guess
   about a moving target.

Never answer from what you already know about the tool. That is how a student spends an
evening on a flag that was renamed in June.

### Choose the connection shape

Prefer, in this order, and say which you picked and why:

| Shape | Pick it when | Watch for |
|---|---|---|
| **Official MCP server** | The vendor publishes one | The cleanest option. Scopes are usually explicit |
| **Official CLI** | A real command-line tool exists | Often better than an API for file-shaped work. Needs installing per machine |
| **A small script against their API** | No MCP, no CLI, but a documented API | You are now maintaining it. Keep it to one file and say so |
| **Browser automation** | None of the above | Last resort. Brittle, breaks on redesigns. Tell them that before building it, not after |

If the tool offers nothing at all, say so plainly and stop. "This cannot be connected
properly today" is a real answer, and it is better than something that works twice.

## 4. Wire it

- Secrets go in `.env`, never in chat, never in a file that gets committed. Add the **name
  only** to `.env.example` so the next machine knows what is missing.
- If the tool needs an OAuth sign-in, hand them the exact link and the exact scopes, and say
  what each scope lets the team do. **Ask for the minimum that makes the job work.** They can
  widen later; nobody ever narrows.
- **Multiple accounts of the same tool are the norm, not the exception** — two ad accounts,
  a personal and a business inbox, a sandbox and a live payment account. Ask which one this
  is, name it explicitly in the register, and never let a nameless second account exist. A
  job that runs against the wrong account is worse than a job that fails.

## 5. Prove it

Run one read that returns **their own data**, and show them the answer:

| Tool | The proof |
|---|---|
| Calendar | "What is on my calendar tomorrow?" |
| Inbox | The subject lines of the three most recent messages |
| Payments | The count of transactions in the last seven days |
| CMS or store | The titles of the three most recent posts or products |
| Anything else | The smallest read that could only work if this is really connected |

If the read fails, **that is the phase**, not a footnote. Fix it and read again. Do not
register a connection that has not answered.

## 6. Register it

Add or update its entry in `connections/register.yml`:

```yaml
connections:
  - name: Gmail - business
    slug: gmail-business
    kind: connector          # connector | mcp | cli | script | browser
    account: you@example.com
    scopes: [read, draft]
    verified: 2026-08-20
    proof: "Read the subject lines of the three most recent messages"
    used_by: [inbox-triage]
```

`used_by` is what makes the register worth keeping: it is how the weekly tune-up spots a
connection that is configured but reaches nothing, and a workflow that needs something the
team cannot reach.

## 7. Write the recipe

Tier 3 only, and it is not optional. `connections/recipes/<slug>.md`:

```markdown
---
name: <Tool>
kind: mcp | cli | connector | script | browser
verified: <YYYY-MM-DD>
source: <the URL you actually read>
---

# Connecting <Tool>

## What it gives the team
<One line.>

## Steps
<Numbered, exact. The commands, the URL, the scopes to tick.>

## Proof
<The read that confirms it, and what a good answer looks like.>

## Known traps
<Anything that cost you time here. This is the most valuable section.>
```

The research took twenty minutes; the recipe makes the next one take two. Over a few months
this folder becomes the catalogue nobody had to write up front.

## 8. Where they talk to their team

The surfaces are connections too, and they are worth offering explicitly — most people
assume there is only one. Ranked by what it costs them:

| Surface | Cost | Best for |
|---|---|---|
| **claude.ai on their phone** | Nothing, works today | Bookmark it and talk to the repo from anywhere. Start here, always |
| **The dashboard** | Already deployed | Watching, firing a job, filing a task or a workflow request |
| **Claude Code on the desktop** | Already installed | Real work, long sessions, anything they want to watch |
| **A messaging gateway** — WhatsApp, Telegram, Signal | A small always-on machine, a few dollars a month | Talking to the team the way they text a person. Register it in `runtimes.yml` and the dashboard shows whether it is alive |

Offer all four. Set up the first three in the same session — they cost nothing — and treat
the gateway as its own project on its own day.

## 9. Finish

Follow `.claude/skills/run-log/SKILL.md`. The register entry, the recipe, any `.env.example`
name, and the run log go in the same commit. **The `.env` file itself is never committed** —
check before you commit, every time.

Then say what changed in one line, and what the team can now do that it could not do an hour
ago.

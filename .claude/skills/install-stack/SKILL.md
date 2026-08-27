---
name: install-stack
description: Install and verify the starter stack every team gets - current-events research, official documentation lookup, memory that survives a session, cost awareness, and the surplus burn calibrated to this owner's own weekly reset. Idempotent, so it is safe to run on a new machine or any time something looks missing. Use at the start of an install, and whenever a tool the team relies on has gone missing.
audience: team
---

# Installing the starter stack

Five capabilities no agent team should start without. They are not optional extras, they are
the floor, and they go in before any workflow is built — a team that starts without them
spends its first month confidently wrong about things it could have looked up.

| Capability | What it fixes |
|---|---|
| **Current events** (`last30days`) | An agent answering from training data is out of date and does not know it |
| **Official docs** (`context7`) | Connection and API details change monthly; recall is not good enough |
| **Working memory** (`claude-mem`) | Sessions close and everything learned in them is lost |
| **Cost awareness** (`token-saver`) | Nobody can manage a bill they cannot see, or pick a model without knowing the trade |
| **Surplus burn** (`surplus-burn`) | Unspent subscription capacity expires every week; this spends it on quality instead. **Needs calibrating to this owner** — see step 4b |

The sixth capability — the loop that makes the team better every week — is already in this
repo as `workflows/weekly-tune-up.yml`. It is not installed, it is inherited.

## 1. Read the declared stack

`stack.yml` is the list. Never install from memory of this file — read it, because it moves.

Entries with a `plugin` field are installed. Entries with a `skill` field already ship in
this repo and need nothing but a mention — except `surplus-burn`, which needs calibrating.

## 2. See what is already there

```bash
claude plugin list
claude plugin marketplace list
```

Anything already installed is left alone. **This skill is safe to run twice** — that matters
because the most common time to run it is on a second machine, when nobody remembers what
was done on the first.

## 3. Install what is missing

For each missing entry, add its marketplace, then install it:

```bash
claude plugin marketplace add <marketplace>
claude plugin install <plugin>
```

The `<plugin>` value already carries its marketplace — `last30days@last30days-skill` — so it
resolves unambiguously even when several marketplaces offer a similar name.

If a marketplace is already registered, `add` is a no-op and you move on. If an install
fails, **say which one and why, then keep going with the rest.** One unavailable plugin does
not justify abandoning the other three, and a half-finished install nobody was told about is
the worst outcome here.

## 4. Verify each one, out loud

An installed plugin is not a working plugin. Run each entry's `verify` line and show the
answer:

| Capability | The proof |
|---|---|
| `last30days` | Run it on a topic the owner knows well. **Check the dates are recent** — that is the whole point of it |
| `context7` | Resolve a library they actually use and return its current docs |
| `claude-mem` | Say what it will now remember, and what it will not |
| `token-saver` | What this session has cost so far, and why |
| `surplus-burn` | How much of this week is left and when it resets — from the calibrated config, not a guess |

Report each as working or not working. **Never report a stack as installed when a capability
has not answered** — the failure would otherwise surface weeks later as an agent quietly
guessing at documentation.

## 4b. Calibrate the surplus burn to this owner

Every Claude subscription resets its weekly limit at a different moment. The skill ships
**uncalibrated** (`resetWeekday: null` in `.claude/skills/surplus-burn/config.json`) and
refuses to guess, so this step is not optional.

1. Probe the real limits:

   ```bash
   node .claude/skills/surplus-burn/usage-probe.mjs
   ```

   The output includes `resets_at` timestamps. Take the **weekly** one, convert it to the
   owner's local time, and read off the weekday (ISO, 1 = Monday) and hour.

2. If the probe says `no local credentials file` (keychain sign-in) or the endpoint errors,
   ask the owner to open `claude.ai/settings/usage` and read the weekly reset line out loud.
   That page is the source of truth; the probe is only the shortcut.

3. Write both values into `config.json` and show the owner:

   > "Your week resets on Thursday at 6 PM your time. I've written that down — the surplus
   > burn will measure against it. If you change plans, this is the one line to update."

4. Prove it: run `node .claude/skills/surplus-burn/surplus-check.mjs` and confirm it returns
   a `nextReset` that matches what the owner just saw. A mismatch means the weekday or the
   hour is wrong — fix it now, not on the first burn day.

Never copy another owner's reset into this file. The number is theirs.

## 5. Say what changed

Some of these need a fresh session before they load. If so, say it plainly:

> "Three of the four are live now. `claude-mem` loads next time you start a session — close
> this one and open a new one when you are ready."

## 6. Record it

Write the result into `.agent-team/stack-check.md`: each capability, installed or missing,
verified or not, and today's date. The weekly tune-up reads this to spot a capability that
has gone missing, and the note is what tells a second machine what it is still short of.

Commit that file. No run log — this is setup, not a run.

## When something here is not available

Any of these can vanish: a marketplace moves, a plugin is renamed, an install breaks on one
operating system. Do not paper over it. Name the capability that is missing, say what the
team will do worse without it, and offer the fallback:

| Missing | Fallback, and what it costs |
|---|---|
| `last30days` | Web search with an explicit date restriction. More work per question, easier to forget |
| `context7` | Fetch the vendor's own docs directly. Fine, but you have to find the right page each time |
| `claude-mem` | The repo is still the long-term memory. Only the between-session working memory is lost |
| `token-saver` | Ships in this repo — if this one is missing, something is wrong with the repo, not the stack |
| `surplus-burn` probe | The `/usage` page in the browser. The owner reads the reset line; you write it down. Slower, exactly as accurate |

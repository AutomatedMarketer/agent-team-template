# Your AI agent team

Six workers who do their job while your laptop is shut, and leave the results where you will
find them.

This is the repo you copy in **Level 2 of The Claude Code Workshop**. It arrives empty of your
business and full of job descriptions. You fill in the first part; the second part already
works.

---

## What you get

| Specialist | What it owns |
|---|---|
| **Research** | Markets, competitors, prospects, topics — with a link behind every claim |
| **Content** | Posts, captions, scripts, newsletters — in your voice |
| **Email** | Your inbox: triage, archive, and drafted replies |
| **Customer service** | Your customers' questions, answered from your own FAQ |
| **Sales** | Prospect research, outreach drafts, a logged pipeline |
| **Security** | Repo sweeps for leaked secrets and stale tooling — findings you approve one by one |

Plus an **orchestrator** in `CLAUDE.md`. You never open a specialist directly — you talk to
the orchestrator, it delegates, it brings the result back. One front door, six workers.

**Every worker arrives with a working job.** Six workflows ship pre-loaded in
`workflows/` — morning market intel, a content draft queue, inbox triage, a gone-cold
prospect chase, a Friday review of the whole team, and a Monday security sweep of the
repo itself. Onboarding tailors them to your
business; from then on you edit them by asking, never by writing YAML.

---

## The rule that makes it work

> **Everything your team needs lives in the repo. Not on your laptop — in the repo.**

A scheduled run happens in the cloud, on a fresh machine that clones this repo and nothing
else. It never sees your laptop. **If a file is not committed, your agents cannot read it.**

---

## They draft. They never send.

Sending an email, publishing a post, deleting a record, or spending money waits for a person
to say yes. On every run, including unattended ones.

This is not a limitation bolted on afterwards — it is what makes it safe to leave the whole
thing running while you are asleep.

---

## Getting started

Do **not** clone this repo. Press **Use this template** to get your own private copy, then:

```
/plugin marketplace add automatedmarketer/agent-team-os
/plugin install agent-team-os
/onboard
```

`/onboard` walks you through nine resumable phases — pre-flight, your repo, who you are, your
business, your voice, connectors, meeting the team, your first scheduled routine, and a
verification pass. You can stop after any phase and pick it up on another machine next week.

**Make your copy private.** Your pricing, your customers, and the way you talk to them go in
`shared/`.

---

## Where things live

| What | Where |
|---|---|
| The orchestrator | `CLAUDE.md` |
| The six job descriptions | `.claude/agents/` |
| You, your business, your voice | `shared/` |
| The pre-loaded workflows | `workflows/` |
| The skills those workflows chain | `.claude/skills/` |
| What each agent produced | `agents/<name>/output/` |
| Every run, logged and kept | `runs/` |
| The acceptance tests | `tests/` |

---

## Tests

```bash
npm test
```

Zero dependencies, `node --test`, Node 20+. The suite encodes the acceptance criteria for the
repo — agent definitions, safety rules, run-log format, and the prompt blocks — so that none
of it can quietly rot out during a later edit.

---

## Related

| Repo | What it is |
|---|---|
| [`agent-team-os`](https://github.com/AutomatedMarketer/agent-team-os) | The plugin: `/onboard`, `/onboard-ceo`, `/new-agent`, `/add-pack`, `/audit` |
| [`ceo-team-template`](https://github.com/AutomatedMarketer/ceo-team-template) | The same idea, built for running a business rather than marketing one. Produces a weekly Monday Brief |

---

Part of **The Claude Code Workshop** by [Nuno Tavares](https://github.com/AutomatedMarketer).

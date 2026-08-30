# agent-team-template

**A team of AI workers that runs on a schedule, in the cloud, while your laptop is shut.**

This is the repo you clone. It is the office: your agents live here, the jobs they do are written
down here, and everything they produce lands here as files you own.

You do not need to be a developer to use it. You do need to be able to copy a command and press
enter.

---

## Who this is for

Someone running a business, or working in one, who keeps doing the same handful of things every
week and would like most of them to happen without being asked.

**It will not** send an email, publish a post, or spend money. Everything it produces is a draft
that waits for you. That boundary is structural, not a setting.

---

## What is in here

**Eight agents.** Five do your business's work; three maintain the team itself.

| Agent | What it does |
|---|---|
| `research` | Looks something up on the web and comes back with a short report where every claim has a link |
| `content` | Writes posts, captions and newsletters that sound like you, and leaves them as drafts |
| `email` | Sweeps your inbox, archives the noise, tells you what needs you, leaves replies in drafts |
| `customer-service` | Answers a customer's question from the answer sheet you wrote, and says "I don't know" rather than guessing |
| `sales` | Researches a prospect, writes the first message you would actually send, keeps a list of who you approached |
| `editor` *(maintenance)* | Grades what the team produced against a written rubric before it reaches you |
| `security` *(maintenance)* | Sweeps this repo for committed secrets and stale tooling |
| `orchestrator` *(maintenance)* | Works your to-do column, handing each card to the right specialist |

**Nine jobs.** A job is a chain of skills with a name and an owner. Four are yours; five keep the
team honest.

| Job | What lands in your inbox folder |
|---|---|
| `morning-intel` | What moved in your market overnight, before your first call |
| `inbox-triage` | Your inbox sorted: needs you · drafted reply · noise |
| `draft-queue` | Your voice notes turned into post drafts, graded before you see them |
| `gone-cold` | Who in your pipeline went quiet, with a chase message drafted for each |
| `weekly-review` *(maintenance)* | What shipped, what slipped, what went quiet — one page |
| `quality-review` *(maintenance)* | Did the team produce work you actually used? One number, with evidence |
| `security-review` *(maintenance)* | Anything leaking, anything stale |
| `task-sweep` *(maintenance)* | Your to-do cards, worked off and routed |
| `weekly-tune-up` *(maintenance)* | What went wrong twice this week, and what changes because of it |

**Twenty-five skills.** A skill does one task; a job chains several. Eight are business work —
`triage-inbox`, `draft-replies`, `scan-market`, `write-intel-brief`, `collect-voice-notes`,
`draft-content-queue`, `review-pipeline`, `draft-chase-messages`. The other seventeen maintain the
team: syncing, grading, watching upstream for changes, writing run logs.

**Nothing here ships switched on.** Every job arrives `armed: false` with a written reason. See
[Which jobs actually run](#which-jobs-actually-run).

---

## Before you start

| You need | Why |
|---|---|
| **Claude Pro or Max** | Free cannot run scheduled work. This is the hard one |
| **Claude Code**, installed and signed in | It is what reads this repo |
| **A GitHub account**, connected to claude.ai | Your team runs in the cloud from GitHub, not from your laptop |
| **Node.js 20 or newer** | Only for the check commands below. Run `node --version` to see yours |
| **Git**, installed | Every command in the next section is a git command. Run `git --version` |

Everything with a `$`-style block below is typed into a terminal — **Terminal** on a Mac,
**PowerShell** on Windows. The `/slash` commands are typed into Claude Code instead.

You do **not** need to install any packages. There are no dependencies — `npm test` works on a
fresh clone with nothing downloaded.

---

## Install

**1. Install the plugin first.** `/onboard`, `/ledger`, `/match` and `/arm` are not files in this
repo — they come from a separate plugin, and without it step 4 has nothing to run. In Claude Code:

```
/plugin marketplace add automatedmarketer/agent-team-os
/plugin install agent-team-os
```

**2. Make your own copy.** The simplest way is GitHub's **Use this template** button: it makes you
your own repo, with your own history, in one click. Then clone the repo it made you and skip
straight to step 3.

```bash
git clone https://github.com/YOUR-USERNAME/my-agent-team.git
cd my-agent-team
```

If you would rather clone this repo directly, you have to cut it loose from ours first. Skip that
and your first push is rejected, and the drift check reports you permanently behind *our* repo.

On a Mac:

```bash
git clone https://github.com/AutomatedMarketer/agent-team-template.git my-agent-team
cd my-agent-team
rm -rf .git
git init -b main
git add -A
git commit -m "My team"
```

On Windows, in PowerShell — `rm -rf` is not a PowerShell command and it will fail:

```powershell
git clone https://github.com/AutomatedMarketer/agent-team-template.git my-agent-team
cd my-agent-team
Remove-Item -Recurse -Force .git
git init -b main
git add -A
git commit -m "My team"
```

Then make an empty **private** repo on GitHub — no README, no `.gitignore`, nothing ticked — and
push to it:

```bash
git remote add origin https://github.com/YOUR-USERNAME/my-agent-team.git
git push -u origin main
```

The branch has to be **`main`**. `git init` on its own still makes `master` on many installs, the
dashboard looks for `main`, and the mismatch shows up later as an empty board rather than an error.
`git init -b main` above is what settles it; if you already have a `master`, `git branch -M main`
renames it.

**3. Check it works.**

```bash
node --version
npm test
```

`node --version` must say 20 or higher. `npm test` ends with these two lines:

```
ℹ pass 424
ℹ fail 0
```

Nothing is downloaded and nothing is installed.

**4. Open it in Claude Code and let it introduce itself.**

```
/onboard
```

That walks you through who you are and what the business does. It takes a while, and it is the part
that decides whether everything else is any good.

---

## Did it work?

Five commands, in this order. Each tells you something different.

```bash
npm test                 # ends with "pass 424 / fail 0". If this fails, the clone is broken
npm run check:ledger     # your week, measured
npm run check:proposals  # what your numbers say your team should be
npm run check:arming     # which jobs actually ring
npm run check:verdicts   # what you did with the work, and whether it can be counted
```

On a fresh clone the last four **tell you what is missing** rather than failing mysteriously.
`No ledger.yml yet. Ask for one: /ledger` is the correct answer before you have run `/ledger`.

Two of them also **exit non-zero** while they are saying it, which is right for anything automated
and looks alarming in a terminal. A red mark before you have run `/ledger` is the tool agreeing
with you, not a fault.

---

## How it actually works

**You measure first.** `/ledger` interviews you about where your week goes and writes `ledger.yml`
— your own words, quoted, with the hours derived from how often and how long. Nothing is built in
that step, on purpose.

**Then your numbers pick the team.** `/match` reads that file and proposes what should answer each
line of it. Every proposal cites three things: your words, your number, and something that already
exists in this repo. **Missing any one, and it is refused.** Where nothing fits, it says so — and
that gaps list is worth more than the proposals, because it is the specification for what gets
built next.

**Then you switch on only what you approved.** `/arm` turns approved jobs into real scheduled
routines, one at a time, each confirmed afterwards.

### Which jobs actually run

A file saying `schedule: "daily 06:30"` makes **nothing** happen at 06:30. A *routine* is the alarm
clock. This repo ships nine files that name a schedule and no routines at all, on purpose — every
one of them arrives **off**, with a written reason, which is what `check:arming` reports. *Declared*
in the table below is the state you reach later, by claiming a schedule and not arming it.

```bash
npm run check:arming
```

| State | Means | Costs you |
|---|---|---|
| **armed** | The file says run it, and a routine exists | Runs, on schedule |
| **declared** | The file says run it, and **nothing rings** | Nothing — it is a wish |
| **unapproved** | A routine **rings** that the file says is off | Runs nobody approved |
| **off** | Deliberately off, with a written reason | Nothing, honestly |

---

## When it breaks

| What you saw | What to do |
|---|---|
| `npm test` fails on a fresh clone | You are probably on Node 18 or older. Check `node --version`, upgrade to 20+ |
| `No ledger.yml yet` | Correct, before you have run `/ledger`. Run it |
| `No usable snapshot of your routines` | Run `/routines` in Claude Code and commit the file it writes |
| `the file says run it and nothing rings` | A job claims a schedule with no routine behind it. Arm it, or set `armed: false` with a reason |
| `is not armed and carries no reason` | Say what would have to change for that job to be worth a run. "Not needed" is not a reason |
| `/onboard` or `/ledger` is not a command | The `agent-team-os` plugin is not installed — it lives in a separate repo |
| A job fires twice a day | Two routines for one job. The API cannot delete them; remove one at `claude.ai/code/routines` |
| Everything says UNKNOWN | No routines snapshot committed. Run `/routines`, commit, push |

---

## The commands you will actually use

All but the last come from the **`agent-team-os` plugin**, installed separately — they are not
files in this repo. `/connect` is a skill that ships **in here**, in `.claude/skills/connect/`.

| Command | What it does |
|---|---|
| `/onboard` | Sets the team up, start to finish |
| `/ledger` | Interviews you about your week, writes `ledger.yml` |
| `/match` | Reads your ledger, proposes a team, names the gaps |
| `/routines` | Shows what is actually scheduled on your account |
| `/arm` | Turns approved jobs into real routines, one at a time |
| `/audit` | Diagnoses the team you actually have |
| `/new-workflow` | Builds a job by asking you five questions |
| `/connect` *(in this repo)* | Works out how a tool connects today, and wires it |

---

## What this repo will never do

- **Send anything.** No email, no post, no message. Drafts only, always
- **Spend money without you saying so.** Arming is deliberate, one job at a time
- **Claim something ran when it did not.** Every number traces back to a file in here
- **Delete your work.** A job switched off keeps its file and gains a reason

---

Built by [Nuno Tavares](https://github.com/AutomatedMarketer) for the V-C Ink Level 2 bootcamp.

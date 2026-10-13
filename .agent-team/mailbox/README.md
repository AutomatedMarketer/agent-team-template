# The Mac mailbox: run your board's orders on your own Mac

Optional. Off unless you switch it on. Out of the box, your board sends every Run, Add task and voice order to a
cloud routine. With the mailbox, it sends them to your own always-on Mac instead. The board signs each order and
leaves it waiting; your Mac asks for it, checks it, does it, and pushes the result to your team repo.

If you are not sure you need this, leave the board on cloud. Nothing here is needed for the course.

## Words used in this guide

| Word | What it means |
|---|---|
| **Board** | Your dashboard, the web page on Vercel |
| **Order** | One request the board signs and leaves waiting: add a task, run a job, move a card |
| **Runner** | The small program on your Mac that does everything in this guide |
| **Allowlist** | A file on the Mac, written by you, that says what the runner may do. Nothing else can widen it |
| **Claim** | A note the runner writes down before it does an order, so that order can never run twice |
| **Work copy** | The runner's own copy of your team repo. It is wiped back to match the team repo before every order |
| **Team repo** | Your GitHub repo made from this template |

## What it does and what it never does

| It does | It never does |
|---|---|
| Asks your board for waiting orders every 5 minutes, with its own key | Open a port on your Mac, or let the board call in |
| Refuses any order that is unsigned, edited, expired, meant for another repo or computer, or seen before | Run an order twice - not after a crash, not after a restart, not after a lost claim folder |
| Does Add task, Start, Done, Pause and Approve with its own code - plain edits to your files, **no AI** | Let a card's words talk it into anything |
| Runs a job (morning intel, the task sweep) with Claude Code on your own plan - **no shell, no connectors, no repo hooks** - only if your Mac's own list allows that job | Run a job your Mac's list does not name, whatever the board or the repo says |
| Checks every file that changed before it commits, then commits and pushes itself | Let Claude push, or change any file outside the job's own list |
| Turns **Arm**, **Add skill** and **Add agent** into a card for you to finish in a Claude session | Make a schedule, a skill or an agent on its own |
| Writes what happened to `.agent-team/status/mailbox/<computer>.json`: ids, states and fixed reasons | Put anything you typed in that file, or in a commit message |

## Where things live on the Mac

| What | Where | Why there |
|---|---|---|
| The runner's code | `~/.local/share/agent-mailbox/runner-code` | A copy of this repo that you move by hand. A push to the team repo can never change the code that runs Claude |
| The work copy | `~/.local/share/agent-mailbox/work` | The runner's own clone of your team repo. It is wiped back to the team repo's `main` before every order, so never work in it |
| The state folder | `~/.local/state/agent-mailbox` | What the runner remembers: the allowlist, the claims, the day's counts, the pause switch, its log |
| The secrets | `~/.config/agent-mailbox/env` | Only you can read it. The runner reads it itself; no shell ever loads it |

The runner refuses to start if any of these is inside another one.

## Set it up

Do these on the Mac Mini itself, in Terminal on its own screen. Do not use SSH. Claude Code's login lives in the
Mac's login Keychain. Only a program started from your own desktop session can read it. Each block says what
it does. Paste one block at a time.

You need an always-on Mac. Claude Code must be installed there and logged in with your own Claude account, not an
API key. You also need Node.js 20 or newer, `git`, and push access to your team repo from this Mac.

### 1. A read-only look first

Nothing here changes anything, and nothing here prints a secret.

```bash
# on the Mac Mini
claude --version; node --version; git --version
claude auth status >/dev/null 2>&1 && echo "Claude is logged in" || echo "Claude is NOT logged in"
[ -n "$ANTHROPIC_API_KEY" ] && echo "an API key is set in this terminal - remove it" || echo "no API key in this terminal: good"
[ -n "$(launchctl getenv ANTHROPIC_API_KEY)" ] && echo "an API key is set for apps - remove it" || echo "no API key for apps: good"
git ls-remote https://github.com/YOUR-GITHUB-NAME/YOUR-TEAM-REPO.git HEAD | cut -c1-12
```

- Each line should say what you want it to. The last one prints the start of your team repo's latest commit.
- If an API key is set anywhere, remove it first. The runner refuses to start with one set, because a key bills
  every call instead of using your plan.

### 2. The runner's code, pinned

```bash
# on the Mac Mini
mkdir -p ~/.local/share/agent-mailbox
git clone https://github.com/YOUR-GITHUB-NAME/agent-team-template.git ~/.local/share/agent-mailbox/runner-code
git -C ~/.local/share/agent-mailbox/runner-code -c advice.detachedHead=false checkout THE-COMMIT-YOU-REVIEWED
```

Use the commit you (or Claude) reviewed. To update the runner later, check out a newer reviewed commit the same
way. Nothing updates it for you.

### 3. The work copy

```bash
# on the Mac Mini
git clone https://github.com/YOUR-GITHUB-NAME/YOUR-TEAM-REPO.git ~/.local/share/agent-mailbox/work
git -C ~/.local/share/agent-mailbox/work push --dry-run origin HEAD:main && echo "push access ok"
```

You do not need to set up git hooks, a git name or a git email in it. The runner rewrites the clone's git settings
before every order and switches git's hooks off on every command.

### 4. The secrets and the allowlist

This makes two secrets on the Mac and copies one at a time to the clipboard, so you can paste each into Vercel in
the next step. They are never shown on the screen.

```bash
# on the Mac Mini
mkdir -p ~/.config/agent-mailbox ~/.local/state/agent-mailbox && chmod 700 ~/.config/agent-mailbox ~/.local/state/agent-mailbox
( umask 077; { echo "MAILBOX_KEY=$(openssl rand -hex 32)"; echo "MAILBOX_SECRET_k1=$(openssl rand -base64 32)"; } > ~/.config/agent-mailbox/env )
cp ~/.local/share/agent-mailbox/runner-code/.agent-team/mailbox/allowed-orders.example.yml ~/.local/state/agent-mailbox/allowed-orders.yml
grep '^MAILBOX_KEY=' ~/.config/agent-mailbox/env | cut -d= -f2- | pbcopy; echo "MAILBOX_KEY copied - paste it into Vercel now"
```

Then open `~/.local/state/agent-mailbox/allowed-orders.yml` and change the board address and the repo name to yours.
**This file is the Mac's say on what may happen.** With no file, nothing runs. It names the board the Mac will talk to.
It names the repo and the computer it works for. It lists the kinds of order it does, and the jobs Claude may run,
with a time limit for each. It sets the most it will do in a day. The team repo can never widen it.

Once the first secret is pasted into Vercel, copy the second:

```bash
# on the Mac Mini
grep '^MAILBOX_SECRET_k1=' ~/.config/agent-mailbox/env | cut -d= -f2- | pbcopy; echo "signing secret copied - paste it into Vercel now"
```

### 5. Vercel (in your browser)

Follow the board's own guide: [Orders on your own computer](https://github.com/AutomatedMarketer/agent-cockpit#orders-on-your-own-computer-mac-mailbox).
In short, Production gets `FIRE_MODE=mailbox`, `MAILBOX_KEY` and `MAILBOX_SECRET` (both Sensitive),
`MAILBOX_SECRET_ID=k1`, `MAILBOX_RUNNER=mac-mini`, `MAILBOX_POLL_SECONDS=300` (on Pro) and a real `FIRE_KEY` of
24 or more characters. Redeploy.

### 6. Check it, then test the walls

```bash
# on the Mac Mini
node ~/.local/share/agent-mailbox/runner-code/scripts/mailbox-runner.mjs --preflight
node ~/.local/share/agent-mailbox/runner-code/scripts/mailbox-runner.mjs --selftest
```

- `--preflight` says, in plain words, what is ready and what is not. It changes nothing and asks nobody.
- `--selftest` builds a throwaway folder and plants traps in it: a hook, a shell skill, a connector and a secret.
  It runs the real Claude against that folder, with the same flags a real run uses.
  It passes only if no trap ran and the secret never came out.
  It uses a little of your plan. Run it again after every Claude Code update.

### 7. One order, watched

The runner refuses any order made before it first ran. That is on purpose, so it can never be handed an old order again.
So run it once with nothing waiting. Then send the test order.

```bash
# on the Mac Mini - the first check: nothing is waiting, and the runner notes the moment it began
node ~/.local/share/agent-mailbox/runner-code/scripts/mailbox-runner.mjs --once
```

Wait a minute. Then, on the board, tap **Add task** with a card called "Mailbox test card". Then:

```bash
# on the Mac Mini - the second check picks the order up
node ~/.local/share/agent-mailbox/runner-code/scripts/mailbox-runner.mjs --once
ls -t ~/.local/state/agent-mailbox/claims/ | head -2
```

The card should now be in your team repo and on the board. `--once` does one check now, whatever the pace.

### 8. Switch it on

```bash
# on the Mac Mini
cp ~/.local/share/agent-mailbox/runner-code/.agent-team/mailbox/local.donna.cockpit-mailbox.plist ~/Library/LaunchAgents/
sed -i '' "s#YOUR-MAC-USER#$(whoami)#g" ~/Library/LaunchAgents/local.donna.cockpit-mailbox.plist
plutil -lint ~/Library/LaunchAgents/local.donna.cockpit-mailbox.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.donna.cockpit-mailbox.plist
launchctl kickstart gui/$(id -u)/local.donna.cockpit-mailbox
```

It runs every 5 minutes (`StartInterval 300`) as a background job that belongs to your own login (a Mac
LaunchAgent), so it can read Claude's login. The board decides
how often it really asks; the runner skips the ticks in between.

## Pause, stop, and put it back

```bash
# on the Mac Mini - pause: nothing is asked, claimed or run, until you remove the file
touch ~/.local/state/agent-mailbox/PAUSE
rm ~/.local/state/agent-mailbox/PAUSE

# on the Mac Mini - remove it completely (the claims stay, as a record)
launchctl bootout gui/$(id -u)/local.donna.cockpit-mailbox
mv ~/Library/LaunchAgents/local.donna.cockpit-mailbox.plist ~/Desktop/
```

To send orders back to cloud routines, set `FIRE_MODE=cloud` in Vercel (or remove it) and redeploy. Orders still
waiting expire by themselves.

## What you can look at

| Look at | It tells you |
|---|---|
| `~/.local/state/agent-mailbox/runner.log` | One line per check: what it did, in counts and words |
| `~/.local/state/agent-mailbox/last-tick.json` | When it last ran, when it last asked the board, and how that went |
| `~/.local/state/agent-mailbox/claims/<id>.claim/` | One folder per order it has seen: the order as it came, a receipt, the final word, and for a run the whole transcript (only you can read it) |
| `.agent-team/status/mailbox/<computer>.json` in your team repo | What the board shows: each order's id, state and reason |
| `~/.local/state/agent-mailbox/counts/` | How many orders and runs today (a New York day) |

## An order the runner lost track of

If the runner or the Mac stops part-way through an order (power, a crash, a kill), that order is marked
**outcome unknown**. The runner then does the one safe thing. It reads your team repo and looks for a commit with that
order's number. The number is a line `Mailbox-Order: <id>` at the end of the commit message. The runner records whether
the change landed, and it **never runs the order again by itself**. To try again, send a new order from the board.

## Change the secret

Do this once a year, and whenever you think a secret leaked.

1. Add a second signing secret on the Mac as `k2`: put a line `MAILBOX_SECRET_k2=...` in `~/.config/agent-mailbox/env`
   (`openssl rand -base64 32` makes one). The runner now accepts orders signed with either.
2. In Vercel, set `MAILBOX_SECRET` to the new value and `MAILBOX_SECRET_ID=k2`, and redeploy.
3. Send a test card. When it works, remove the `k1` line from the env file.

An order sent in the minute you switch can expire unpicked: send it again. To change `MAILBOX_KEY`, change it on both
sides the same day. The two must never be the same value; the runner refuses a file where they are.

## If something is wrong

Each check ends with one line in `runner.log`, like `mailbox tick: done - 1 claimed, 1 done, 0 refused, 0 failed`.
`done`, `waiting` (the board's pace says it is too soon), `paused` and `busy` (another check is still running) are
normal. A `busy` that lasts more than an hour means a check was cut off in the middle. The lock it left clears itself
after an hour. For the others the line also gives a reason in brackets. This is what they mean.

| You see | What it means | What to do |
|---|---|---|
| `unavailable (no-allowlist)` | There is no `allowed-orders.yml` in the state folder | Copy the example (step 4). With no file, nothing runs |
| `unavailable (allowlist-board)`, `-repo`, `-jobs`... | That part of the allowlist is not usable (the word names the part, never the value) | Fix that line. A line it cannot read breaks the whole file, on purpose |
| `unavailable (keys-mode)` | The secrets file can be read by someone else | `chmod 600 ~/.config/agent-mailbox/env` |
| `unavailable (keys-...)` | The secrets file is missing, or a key is the wrong shape, or the board key equals a signing secret | Make it again (step 4) |
| `not-ready (places-...)` | One of the four places sits inside another | Put them back where this guide puts them |
| `not-ready (key-in-environment)` | An API key (or a Claude address) is set for the runner | Remove it. The runner runs on your plan, never a key |
| `not-ready (origin-mismatch)` | The work copy's origin is not your team repo | Fix the clone's origin |
| `board-failed (board-refused)` | The board does not accept the Mac's key | `MAILBOX_KEY` differs between Vercel and the env file |
| `board-failed (board-unreachable)` | No answer from the board, or it is not in mailbox mode | Check `FIRE_MODE=mailbox` and the deploy |
| `board-failed (board-bad-answer)` | The board answered, but not in the agreed shape | Check that the board and this runner are on the same release, and that Vercel is not asking for a sign-in on the production address |
| `not-ready (work-...)` | The work copy could not be brought level with the team repo | Check the network and that `git push` works from the work copy (step 3) |
| `stopped (store)` | The claims folder could not be opened | Check the disk and the state folder's rights |
| `stopped (claim-failed)` | A claim could not be written to disk, so nothing was done | Check the disk and the state folder's rights |
| `stopped (counts-damaged)` | The day's counts file is damaged; it reads as full | Look at `counts/`, delete that day's file once you know why |
| An order shows **refused** on the board | The Mac turned it down for a fixed reason (not on its list, daily limit, expired...) | The board shows the reason in words |
| An order shows **failed** | It started and nothing left the Mac | Look at the claim folder's transcript |
| Everything refused as "not valid" after the claims folder was wiped | The runner records when its claims began and refuses any order issued before that, so a lost claims folder can never run an old order again | Wait for new orders; this is the safe behaviour |

## How it keeps your Mac safe

| Wall | How |
|---|---|
| Nobody else can give it orders | Every order is signed with a secret only Vercel and your Mac hold. The signature is checked before the order is even read |
| An order cannot run twice | The claim is a new folder, saved to the disk **before anything is done**. It is kept for ever. The claims folder also records the day it began, and refuses any order made before that |
| The Mac decides what is allowed, not the board and not the repo | `allowed-orders.yml` in the state folder. The team repo can never widen it |
| Claude has no shell and no connectors | `--tools` names seven built-in tools and Bash is not one; `--disallowedTools "mcp__*"`; an empty `--strict-mcp-config`. Any call to another tool stops the run on the spot |
| Claude cannot reach beyond the work copy | `--permission-mode dontAsk` denies anything not allowed, and reads of `~/.ssh`, `~/.config`, `~/Library`, `~/.claude`, the state folder and the runner's own code are denied as well |
| Nothing in the team repo can run | `--setting-sources user` (the repo's settings, hooks and environment are never read), `disableAllHooks`, no skills or commands (`--disable-slash-commands`), no `.mcp.json`, and git's hooks switched off |
| Every changed file is checked | Per action and per job, from a fixed list in the runner's code. Anything else - a deletion, a link, a file in `.claude/`, `.github/`, `scripts/`, a package file - fails the order and nothing is pushed |
| Only the runner pushes | One commit that names the order, and the push only goes through if the team repo is still exactly where the runner started. If it moved, a card edit is made again on top. A run's files are put back only if nothing they touch changed. Claude is never run again for it |
| A runaway is stopped | A time limit per job (the allowlist's minutes), then everything Claude started is stopped. A limit on turns. Daily limits on orders and runs |

The flags are the ones Claude Code documents. Read the [CLI reference](https://code.claude.com/docs/en/cli-reference),
[running Claude Code programmatically](https://code.claude.com/docs/en/headless) and
[permissions](https://code.claude.com/docs/en/permissions). The last one says what a `claude -p` run reads from a
folder it was never asked to trust, and why `--setting-sources user` matters.

## On a Windows computer

Not tested. The pieces are the same - the runner is plain Node.js - but nobody has run the schedule on Windows yet.
The shape would be a Task Scheduler task that runs every 5 minutes. It must run **only when you are logged on**, so
Claude's login can be read. It would run `node scripts/mailbox-runner.mjs` from the runner's code folder. Windows has no
file modes, so the secrets file is not checked for who can read it. Keep it in your own user folder. Do not treat this
as a tested setup until you have run `--preflight`, `--selftest` and one watched order yourself.

## Not yet verified on a real Mac

These are checked on the Mac at steps 6 and 7, and the guide will be corrected from what they show:

- Whether this Mac's Claude Code is new enough for `--permission-prompts none` (2.1.259 or later). If not, the flag is
  left out and a prompt is denied anyway.
- That `--settings` with `disableAllHooks` also stops hooks from your own plugins in a `-p` run.
- That an empty `--strict-mcp-config` also keeps out claude.ai connectors and plugin servers.
- Which closing tool calls Claude Code makes on its own. Any call to a tool outside the list stops the run.
  A harmless tool that is not on the list would stop a good run. `--selftest` and the first runs show it.
- That Claude Code leaves no files of its own in the work copy. Any file it left would fail the changed-file check.
- That the board's address answers a plain request from the Mac. If Vercel's Deployment Protection is on for the
  production address, the Mac gets a sign-in page, not orders. Then `--once` says `board-failed (board-bad-answer)`.

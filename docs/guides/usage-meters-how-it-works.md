# How the usage meters work

The tech behind the **Plan limits** meters on the dashboard. The step-by-step setup is in
[Usage meters on your dashboard](usage-meters.md). The exact file format, every command-line option
and the Mac schedule are in [the status README](../../.agent-team/status/README.md) - this page
explains the design and links there rather than repeating it.

---

## The problem it solves

The dashboard is a website. It runs in the cloud and can be opened on a phone anywhere. That also
means it **cannot see your computer**. It can only read your team repo on GitHub.

Your usage numbers live on your computer: inside Claude Code while it runs, in Claude Code's files,
in Codex's logs. So something on your computer has to read them and send them up. That something is
the **collector**, and it sends them up as a small file in your team repo.

### What a local app does differently

Jack Roberts' Agentic OS dashboard (an app we studied for ideas only - none of its code or art is
in here) solves this the other way round. It **runs on your own computer**, at a local address in
your browser. It reads your files directly, and reads the same kinds of sources again each time
you press Refresh (or when the page loads and its last reading is over 3 hours old - from our own
review of it, 2026-10-06). That works because it is on the same machine. The price is that you can only
look at it from that machine.

Ours is a website, so it cannot reach in and read. Instead a collector **pushes numbers out**: it
runs on your computer, writes a snapshot, and commits it. The board then shows when each reading
was taken, so an old number never pretends to be a new one. Two other differences, by design:
our live call says honestly who it is (`User-Agent: agent-team-collector/1`) rather than claiming
to be Claude Code, and nothing here prices your usage with a made-up table.

---

## The data flow

```
 Claude Code (interactive session)
   │  after each reply, runs your status line command with session JSON on stdin
   ▼
 scripts/usage-tap.mjs ─────────────► prints "5h 18% · wk 49%" (or your earlier status line)
   │  keeps ONLY rate_limits.five_hour and rate_limits.seven_day
   ▼
 a small file on this computer, outside every repo
   Mac / Linux: ~/.local/state/agent-status/claude-statusline.json
   Windows:     %LOCALAPPDATA%\agent-status\claude-statusline.json
   │
   ▼
 scripts/collect-status.mjs   (by hand with /snapshot, or every 3 hours on an always-on Mac)
   │  reads every source below, in order, then the safety gate checks the result
   ▼
 .agent-team/status/usage/<computer>.json   in your team repo
   │  git commit (that one file only) + push, guarded by a lease
   ▼
 GitHub ──► the dashboard reads the file ──► Plan limits on the Today screen
```

---

## Every source, and the order they are tried in

### Claude limits - the 5-hour and weekly meters

The collector tries these **in this order** and uses the first that works:

| # | Source | Official? | Written as |
|---|---|---|---|
| 1 | **The status line tap.** Claude Code's own reading, which it hands to the status line ([documented here](https://code.claude.com/docs/en/statusline)). Used if it is **under 6 hours old** and at least one of its windows has not reset since | **Yes** | `claude-code-statusline` |
| 2 | **The live call.** Your Claude sign-in (Mac Keychain first, then `~/.claude/.credentials.json`) is sent to the address Claude Code's `/usage` screen uses | No - undocumented | `unofficial-live` |
| 3 | **Claude Code's saved reading** in `~/.claude.json`, if under 6 hours old | No - undocumented | `claude-code-saved` |
| 4 | Nothing worked: **unavailable**, with the most useful reason | - | - |

When the tap's reading is fresh, step 2 never runs, so **your sign-in never leaves the computer**.

The tap only has numbers on a computer where someone **used Claude Code interactively** in the last
6 hours, on a Pro or Max plan, after Claude's first reply in that session. The status line only
runs in interactive sessions, so headless runs (`claude -p`) never reach the tap, and a Mac that only
runs jobs on a schedule will usually fall through to step 2 or 3. That is why the backup steps are
kept. The limits are per account, not per computer, so a reading from any of your computers is a
true reading of your plan.

### Why the tap has its own name

The list of source names is a **shared contract** between this repo and the dashboard
(`tests/fixtures/usage-parity.json`, the same bytes in both repos, checked by a test in each). The
tap's reading is written as `claude-code-statusline`, a name of its own, because it is the one
Claude reading Anthropic documents. So the dashboard shows it as official -
"from Claude Code’s status line" - with no "unofficial" label. The two backup readings keep their own names
(`unofficial-live` and `claude-code-saved`) and their "unofficial" label.

### The other numbers

| Number | Source | Written as |
|---|---|---|
| Claude plan ("Max 20x") | The plan fields of the same sign-in. Only a name from a fixed list can come out | - |
| Claude activity | Claude Code's session and subagent logs in `~/.claude/projects`, last 15 days | `estimate` |
| Codex limits | The newest reading in Codex's own session logs, `~/.codex/sessions`, up to 7 days old | `codex-session-log` |
| Codex plan | The plan claim inside `~/.codex/auth.json` | - |

---

## The tap, in detail

`scripts/usage-tap.mjs` (the logic is in `scripts/lib/status/tap.mjs`).

- **What it keeps.** From the whole status line JSON, only `rate_limits.five_hour` and
  `rate_limits.seven_day`: a percentage and a reset time each. `spend_limit` (a dollar budget behind
  a company gateway) is ignored. The file holds `schema`, `capturedAt` and `windows` - nothing else.
- **What it never keeps.** The same JSON carries your working folder, session ids, the transcript
  path, the model, the cost, the repo name. None of it is written. The file is built from numbers
  only, and passes the same safety gate as the snapshot before it is written.
- **Quiet writes.** An unchanged reading is rewritten at most once a minute. A changed one is
  written at once. If a session has no reading yet, the last good file is left alone.
- **All or nothing.** It writes a temporary file beside the real one and renames it over. Claude
  Code cancels a status line that is still running when the next update arrives; a rename cannot be
  half done.
- **Never breaks your status bar.** It never exits with an error and never prints one. Anything it
  printed would land in the bar.
- **Fast.** About 10 ms of its own work on top of Node's start-up (measured on Windows: Node alone
  about 47 ms, the tap about 58 ms).

### Keeping your own status line: `--then` and `--then64`

Many people already have a status line. The tap takes `--then <command>`: it passes the **same
stdin** to that command and prints **its** output, so the bar looks exactly as before. With no
`--then`, it prints the short `5h 18% · wk 49%` line, or nothing if there is no reading.

The installer writes the earlier command as `--then64 <code>`, the same text in base64url. Why: a
status line command is run by `/bin/sh` on a Mac, and on Windows by Git Bash or PowerShell. They
quote differently, and status lines often hold quotes (`jq` one-liners do). Encoded, the command
passes through any shell untouched.

**The trade-off of running the earlier command through a shell.** The tap starts a shell to run it:
`/bin/sh -c` on a Mac or Linux; on Windows, the Git Bash that Claude Code names in `SHELL`, or
PowerShell when there is none - the same shell Claude Code would have used. That costs:

- **Time.** One more shell start per update: a few milliseconds for `sh`, more for PowerShell.
- **A guess on Windows.** If Claude Code used a different shell from the one the tap picks, an
  earlier command written for the other shell may fail. Then the bar goes blank, and
  `node scripts/install-usage-tap.mjs --remove` puts the old line back.
- **No new trust.** The earlier command is your own, and it ran through a shell before. Nothing new
  gets to run.

An earlier command that hangs is stopped after 10 seconds. If it fails, the bar is left empty
rather than showing an error.

---

## The installer

`scripts/install-usage-tap.mjs` (the logic is in `scripts/lib/status/install-tap.mjs`).

- **One key only.** It changes the `statusLine` key in `~/.claude/settings.json` (or the folder
  `CLAUDE_CONFIG_DIR` names), and nothing else. Your indentation is kept. If `settings.json` is a
  link (a dotfiles repo), the file it points to is changed and the link stays a link; the file's
  permissions are kept, so a private (0600) file stays private.
- **Backup first.** Before any change it copies the file to
  `settings.json.before-usage-tap-<UTC time>.bak` beside it.
- **It runs a copy, never your repo.** The status line runs after every Claude reply, with no
  permission prompt. If it ran the tap out of your team repo's working copy, anyone who can push to
  the team repo would choose code that runs on your computer after your next pull - the same reason
  the always-on Mac runs the collector from a checkout pinned by hand (below). So the installer
  copies `usage-tap.mjs` and every file it imports into a folder named after a hash of their
  contents - `~/.local/share/agent-status/tap/<hash>/` on a Mac or Linux,
  `%LOCALAPPDATA%\agent-status\tap\<hash>\` on Windows - checks the copy byte for byte, and points
  the status line at the copy. Nothing in the copy imports anything from the repo. A pull does not
  change it. **Running the installer again** is the deliberate update: new code gets a new folder,
  and the old one is deleted. If the copy was changed after it was made, the next run puts it back.
- **Absolute paths.** The command names the full path of `node` and of the copied tap, with forward
  slashes, quoted for the shell that will run it (`'...'` for sh and Git Bash; `& '...'` for
  PowerShell, which only runs a quoted path with `&`).
- **Twice is the same as once.** It recognises its own command and never wraps itself. Run it again
  after the tap's code changes and it moves to the new copy, still chaining your original status line.
- **`--remove` undoes it exactly.** The earlier command travels inside the new one, so removing
  puts back the very same `statusLine` - or none, if there was none. `--remove` also deletes the copy
  of the tap it made.
- **It refuses rather than guesses.** A settings file that is not plain JSON, a status line that is
  not a command, or a tap you wired in by hand: nothing changes, and it says why.
- **`--dry-run`** shows the change and writes nothing.

**Where you run the installer from still matters**, because that is the code it copies. On the
always-on Mac, install it from the **pinned code checkout** (see below), never from the data clone -
the data clone is reset to whatever the team repo holds on every run. On a laptop, read what
changed in the tap before running the installer again.

---

## What is never written, and how that is enforced

Never written anywhere: sign-in tokens, keys or anything shaped like one; your email, name or
account id; your username, home folder or any path outside the repo; project names, working
folders, session ids, transcript paths, or anything you or Claude typed; the computer's own name.

This is enforced in layers, not promised:

1. **Sources return only safe fields.** Each source picks out percentages, times and names from
   fixed lists. An unknown answer shape is "unavailable", never a partial reading.
2. **The gate** (`scripts/lib/status/safe.mjs`) checks **every** file, receipt and printed line
   before it leaves the process. Allowed keys only; strings at most 60 characters; no `@`, `/`,
   `\`, `eyJ`, `sk-` or `Bearer`; never the username, home folder or computer name. **It fails
   closed**: one problem and nothing is written, and the message names the field, never the value.
   The tap's file passes the same gate, against its own shorter list of keys.
3. **The leak tests** build a fake home full of fake tokens, emails and a `secret-client` project,
   plus a fake server that echoes the token back, and prove none of it reaches any output:
   `tests/status-run.test.mjs` (the whole collector), `tests/status-usage-tap.test.mjs` (the tap,
   fed a status line JSON full of folders and ids), and `tests/status-tap-source.test.mjs` (a hostile
   tap file).
4. **No real machine in tests.** `tests/status-spawn-scan.test.mjs` refuses any test that could run
   the real collector against the real Keychain, and the installer's tests only ever touch a
   temporary home. Fake tokens are assembled at run time, so `tests/secrets.test.mjs` can scan the
   whole repo for token shapes.

### Reasons, and the log

When a source does not work, the snapshot says **why**, in a few words and never a value:
`status line reading too old`, `live answer refused`, `sign-in found but holds no key (file, no
Keychain answer)`. On a Mac a live reason also says where the sign-in came from: the Keychain, or
the file because the Keychain gave no answer or an unreadable one.

The collector's printed summary lists **every source it tried**, in order, under the Claude limits
line - so when a backup was used you can see why each earlier source was passed over, not just the
last reason:

```
- Claude limits found (claude-code-saved)
  - status line: unavailable (status line reading too old)
  - live: unavailable (live answer refused (Keychain))
  - saved: found
```

That list is printed only. It is never written into the snapshot.

---

## The always-on Mac: two folders and a guarded push

The Mac runs the collector every three hours. The full setup, with the schedule file, is in
[the status README](../../.agent-team/status/README.md#the-mac-schedule-phase-4-task-t14). The design
in short:

- **Two folders.** The **code checkout** holds the collector that runs. It is **pinned by hand** to a
  commit you have read, and never updates itself. The **data clone** is where snapshots are written
  and pushed, and it is reset to the team repo on every run. Why: anyone who can push to the team
  repo decides what the data clone holds. If the code ran from there, they would choose code that
  runs on the Mac with access to its Keychain. The collector refuses to run if its own code is
  inside the data clone.
- **A guarded push.** Every push carries a **lease**
  (`git push --force-with-lease=refs/heads/main:<last fetched id> ...`): it lands only if the team
  repo's `main` is still exactly what this copy last saw. It pushes the snapshot's own commit, one
  commit, nothing else. In your own working copy, if anything else would travel too, it commits the
  snapshot and does not push, and says why. In the data clone a refused push is caught up and
  retried once.
- **No hooks, no links.** Git in the data clone never runs hooks, and the collector refuses to write
  through a folder that is really a link to somewhere else.

---

## Not verified yet

- Whether macOS shows the Keychain prompt, and its exact words.
- Whether Claude Code's Keychain item is ever printed as hex (the collector decodes it if so).
- Whether the shell the tap picks on Windows always matches Claude Code's own choice.
- The first live run on the Mac (2026-10-08) found a sign-in with a plan and no usable key. The new
  reasons will say where that sign-in came from on the next run.

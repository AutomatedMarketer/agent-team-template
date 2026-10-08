# Status snapshots

This folder holds small files that describe a computer, written by a script on that computer and
read by the dashboard. The dashboard runs in the cloud and cannot look at your machine, so the
machine writes down what it sees and commits it here.

It writes two kinds, called **parts**:

- **usage** (Phase 4) - how much of your Claude and Codex plan limits are used, which plan you are
  on, and an estimate of how much Claude Code you have been using.
- **connections** (Phase 5) - the Connections wall: which tools are installed and their versions,
  and which Claude Code and Codex servers and plugins this computer has, and whether each one
  connects. **Names only** - see [The connections file](#the-connections-file).

```
.agent-team/status/usage/<computer>.json
.agent-team/status/connections/<computer>.json
```

One file per part per computer. `<computer>` is the label you give with `--computer`, turned into a
file name: `--computer "Mac Mini"` writes `mac-mini.json`. With no label the file is
`this-computer.json`. The label is never the computer's own name, because a computer's name is
often its owner's name.

A run collects every part unless `--only` picks some. The parts travel together: every part passes
the safety check before **any** file is written, and `--commit` puts all of them in one commit.

## Run it

```bash
npm run collect:status -- --dry-run                       # print the files, write nothing
npm run collect:status -- --computer "Mac Mini"           # write the files here
npm run collect:status -- --computer "Mac Mini" --commit  # write them, commit only them, push
npm run collect:status -- --only connections --dry-run    # one part only
```

| Option | What it does |
|---|---|
| `--computer "<label>"` | The name shown on the dashboard. Up to 60 characters: letters, numbers, spaces and `. , ' ’ ( ) + & : _ -` only, no stretch of 24 or more without a space, and not this computer's own name |
| `--dry-run` | Prints the files it would write. Writes nothing, commits nothing |
| `--commit` | Writes, commits only the snapshot files, in one commit (anything else you have staged stays staged), pushes it if that is safe - see below |
| `--clone <dir>` | With `--commit`: work in a dedicated clone instead of this copy (see the Mac schedule below) |
| `--state-dir <dir>` | With `--commit`: where the lock and receipts go. Default `~/.local/state/agent-status-collector`. The empty folder programs run from, `empty-cwd`, is made here too |
| `--only usage,connections` | Only these parts, in any order. `--only hermes` is refused: Hermes comes in Phase 6 |

Exit code 0 means it worked, or skipped on purpose (another run held the lock, or this run's time
slot was already claimed). 1 means it refused or failed after reading, or could not reach the team
repo to bring a dedicated clone up to date. 2 means it refused before
reading anything - an unknown option, a bad label, a folder that is not a dedicated clone, or a
`--clone` folder that holds the collector's own code.

In **your own working copy**, `--commit` pushes only when the push would carry the snapshot and
nothing else, to the branch the dashboard reads (`origin`'s default branch, usually `main`). It
commits the snapshot, does **not** push, and says which of these it was when:

- you are on another branch;
- your copy has commits that origin's `main` does not have yet - even if your branch follows
  somewhere else, such as the template's own repo, and git says you are up to date with it;
- your copy is behind origin's `main` (pull first);
- your copy has no remote called `origin`, or has never fetched origin's `main`;
- the team repo has changed since your copy last fetched it - for example a commit was taken
  off it - or your pushes go to a different repo than your fetches (`pushurl`,
  `pushInsteadOf`).

A push in any of those cases could have sent your other work too, or put back a commit someone
removed. Every check is made against what your copy last fetched, so the push itself is
guarded as well: it pushes the snapshot's own commit by id, as a fast-forward of exactly one
commit, with a lease on what it checked -
`git push --force-with-lease=refs/heads/main:<last fetched id> origin <snapshot commit id>:refs/heads/main`.
The lease means it lands only if the team repo's `main` is still exactly what your copy saw;
otherwise nothing is pushed and it tells you to fetch or pull, then take the snapshot again. It
never pushes HEAD, never a bare `git push`, and never anything but that one commit. Either way
the snapshot stays committed locally and nothing of yours is touched.

## The usage file

```json
{
  "schema": "agent-status/usage/v1",
  "takenAt": "2026-10-07T20:00:00Z",
  "computer": "Mac Mini",
  "claude": {
    "plan": { "status": "found", "name": "Max 20x" },
    "limits": {
      "status": "found", "source": "unofficial-live", "readAt": "2026-10-07T20:00:00Z",
      "windows": [
        { "kind": "five_hour", "usedPercent": 18, "resetsAt": "2026-10-07T21:40:00Z" },
        { "kind": "weekly_all", "usedPercent": 49, "resetsAt": "2026-10-09T22:00:00Z" },
        { "kind": "weekly_model", "model": "Fable", "usedPercent": 2, "resetsAt": "2026-10-09T22:00:00Z" }
      ]
    },
    "activity": {
      "status": "found", "estimate": true, "timezone": "America/New_York",
      "days": [ { "day": "2026-10-07", "sessions": 4, "replies": 120,
                  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                  "byModel": { "opus": 0, "sonnet": 0, "haiku": 0, "other": 0 } } ]
    }
  },
  "codex": {
    "plan": { "status": "found", "name": "Pro" },
    "limits": { "status": "found", "source": "codex-session-log", "readAt": "2026-10-07T13:12:41Z",
                "windows": [ { "kind": "weekly", "usedPercent": 0, "resetsAt": "2026-10-14T00:00:00Z" } ] }
  }
}
```

Every block has a `status`: `found`, `not found` (the source is not on this computer) or
`unavailable` (it is there but could not be read, with a short `why`). A percentage only ever
appears inside a block that says `found` - a missing source is never written as a zero. The same
goes for one window: if the address lists a window with no number, that window is left out and the
others are kept. A block holds at most 8 windows. `usedPercent` runs from 0 to 1000: above 100
means you are over the limit, and it is written as it is, never clipped to 100. A window may have no `resetsAt` when the reset
time is not known; the dashboard then says so.

`byModel` counts replies per model family. `activity` is always marked `"estimate": true`: it
counts what Claude Code logged on this one computer, and it never turns into a percentage, because
it cannot know what your plan's limit is.

The exact shape, and the contract the dashboard reads it by, are in
`scripts/lib/status/schema.mjs` and `tests/fixtures/usage-parity.json`.

## Where each number comes from

| Number | Source | Labelled |
|---|---|---|
| Claude limits, first choice | **Official.** The reading Claude Code hands its status line, kept by the status line tap (below) in `~/.local/state/agent-status/claude-statusline.json` (Windows: `%LOCALAPPDATA%\agent-status\claude-statusline.json`), if under 30 minutes old and not every window in it has reset since | `claude-code-statusline` |
| Claude limits, second choice | The address Claude Code's `/usage` screen calls. The sign-in comes from the Mac Keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json` | `unofficial-live` |
| Claude limits, third choice | **Official.** The status line tap's reading again, if the live call failed, up to 6 hours old | `claude-code-statusline` |
| Claude limits, fourth choice | The last reading Claude Code saved in `~/.claude.json`, if under 6 hours old | `claude-code-saved` |
| Claude plan | The plan fields of the same sign-in | - |
| Claude activity | Claude Code's session and subagent logs in `~/.claude/projects`, last 15 days | `estimate` |
| Codex limits | The newest reading in Codex's own session logs, `~/.codex/sessions`, up to 7 days old | `codex-session-log` |
| Codex plan | The plan claim inside the Codex sign-in, `~/.codex/auth.json` | - |

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured if you have moved those folders.

### The status line tap - the official reading

Claude Code hands every status line command the session's details on stdin, and for Pro and Max
that includes `rate_limits.five_hour` and `rate_limits.seven_day` - documented at
https://code.claude.com/docs/en/statusline. `scripts/usage-tap.mjs` is a status line command that
keeps only those two readings in the file above and prints `5h 18% · wk 49%`, or your earlier status
line. Install and remove it with:

```bash
node scripts/install-usage-tap.mjs --dry-run   # show the change to ~/.claude/settings.json
node scripts/install-usage-tap.mjs             # install, keeping your status line via --then64
node scripts/install-usage-tap.mjs --remove    # put back exactly what you had
```

The status line never runs the tap from this repo. It runs after every Claude reply with no
permission prompt, so if it ran the working copy, anyone who can push to the team repo would choose
code that runs on your computer after your next pull - the same reason the Mac runs the collector
from a checkout pinned by hand. The installer copies `usage-tap.mjs` and every file it imports to
`~/.local/share/agent-status/tap/<hash>/` (Windows: `%LOCALAPPDATA%\agent-status\tap\<hash>\`),
checks the copy, and points the status line there. A pull does not change the copy; running the
installer again is the deliberate update, and `--remove` deletes the copy it made.

The installer changes only the `statusLine` key and backs the file up first. The tap's reading is
written as `claude-code-statusline`, its own name in the shared contract, and the dashboard shows it
as official - a "From Claude Code" chip, no "unofficial" label, and a Why? line naming the status
line. When the tap's reading is
under 30 minutes old it wins and the live call is skipped, so the token never leaves the computer.
Older than that, the live call goes first (the status line only updates while Claude Code is in
use, so an older tap reading may be behind), and the tap's reading is used if the live call fails,
up to 6 hours old. The tap carries only the 5-hour and weekly windows - all Claude Code hands its
status line - so the per-model weekly meter comes only from the live call or `~/.claude.json`.

The tap only has a reading where Claude Code was used **interactively** in the last 6 hours: the
status line does not run in headless `claude -p` jobs. On the always-on Mac, install the tap from
the **code checkout** (`~/.local/share/agent-status/collector-code`), never from the data clone.
Students' guide: `docs/guides/usage-meters.md`. The design and every trade-off:
`docs/guides/usage-meters-how-it-works.md`.

### The two undocumented readings

The other two Claude readings are **undocumented**. Anthropic has not published that address or that saved
field, so the dashboard shows them with an "unofficial" label, and either can stop working
without notice. When that happens the meter says `unavailable` rather than showing an old or
invented number. The collector sends the sign-in token to that one address only, with an honest
`User-Agent: agent-team-collector/1`, never follows a redirect with it, and will **never refresh**
an expired token - refreshing it could sign Claude Code out. An expired token means the live
reading is skipped and the saved one is tried.

It also **never sends the token** when this Node could be talking to something other than the
real address: certificate checks switched off (`NODE_TLS_REJECT_UNAUTHORIZED=0`), extra
certificates trusted (`NODE_EXTRA_CA_CERTS`), the system's certificates in use
(`NODE_USE_SYSTEM_CA=1`), or `NODE_OPTIONS` - or Node's own command line - holding
`--use-system-ca`, `--use-openssl-ca`, `--require` / `-r`, `--import`, `--loader`,
`--experimental-loader`, or any debugger option (`--inspect`, `--inspect-brk`, `--inspect-port`,
`--inspect-wait`): a debugger can read the token straight out of memory. The saved reading is
tried instead, and the meter's reason names the setting, never its value.

When a sign-in is found but holds no usable key, the reason says so - `sign-in found but holds no
key (Keychain)` or `(file)` - instead of a fallback's reason. On a Mac every live reason also says
where the sign-in came from: the Keychain, or the file because the Keychain gave no answer
(`file, no Keychain answer`) or one it could not read (`file, Keychain unreadable`). The printed
summary lists every Claude source tried, in order, with its status and reason (`- status line:
found`, `- live: unavailable (...)`, `- saved: not found`); that list is printed only, never written.

## The connections file

What the Connections wall shows: installed tools, and the servers and plugins this computer has.
**Names only.** A server's address, command, arguments, environment and headers have no place in
this file - the shape has no key for them, so the safety check refuses any file that tries.

```json
{
  "schema": "agent-status/connections/v1",
  "takenAt": "2026-10-08T15:00:00Z",
  "computer": "Mac Mini",
  "tools": [
    { "name": "Claude Code", "state": "found", "version": "2.1.293" },
    { "name": "GitHub CLI", "state": "not found" },
    { "name": "ChatGPT app", "state": "could not check" }
  ],
  "claude": {
    "status": "found", "live": "checked",
    "servers": [
      { "name": "github", "scope": "user", "transport": "local", "state": "connected" },
      { "name": "plugin:marketing:supermetrics", "scope": "plugin", "transport": "web", "state": "needs sign-in" },
      { "name": "claude.ai Gmail", "scope": "claude.ai", "transport": "web", "state": "seen before" }
    ],
    "projectServers": 4, "hidden": 1, "more": 0
  },
  "codex": {
    "status": "found",
    "servers": [ { "name": "docs-search", "enabled": true } ],
    "plugins": [ { "name": "github", "from": "openai-curated", "enabled": true } ],
    "hidden": 0, "more": 0
  }
}
```

- **tools** - always these nine, in this order: Claude Code, Codex, Hermes, Node.js, Git, GitHub CLI,
  Claude app, ChatGPT app, Tailscale. `found` (with a version when it gave one), `not found`, or
  `could not check` (it is there, but would not answer, or could not be run safely).
- **claude.servers** - `scope` is `user` (your own servers in `~/.claude.json`), `plugin` (named
  `plugin:<plugin>:<server>`), `claude.ai` (connectors from claude.ai) or `other`. `transport` is
  `local` (a program on this computer) or `web` (a web service), worked out from which keys the entry
  has, never from what is in them. `state` is `connected`, `needs sign-in`, `failed`,
  `waiting for approval`, `not checked`, `seen before` or `unknown`.
- **projectServers** - servers that belong to one project folder. **Counted, never named**: the
  names, like the folders, are often a client's.
- **hidden** - names that failed the name rule and were dropped. **more** - names past the cap
  (100 Claude servers, 50 Codex servers, 60 Codex plugins) that were not written.
- **codex** - `[mcp_servers.<name>]` and `[plugins."<name>@<from>"]` from `~/.codex/config.toml`, with
  `enabled` when the file says it.

The contract the dashboard reads this by is `scripts/lib/status/connections-schema.mjs` and
`tests/fixtures/connections-parity.json`, which also holds the name rule with examples, a full
sample, and the shape the board builds from it. A name is held to the dashboard's characters, at
most 60 of them, none of `@ / \ eyJ sk- bearer`, no id, nothing of yours (username, computer name,
home folder), and no stretch of 24 or more characters between `:` `.` `_` `-` or a space - so
`plugin:marketing:supermetrics` is a name and a 40-character token is not.

### Where each name comes from

| What | Read from | Kept |
|---|---|---|
| Your servers | `~/.claude.json` `mcpServers` | each key (the name), and whether it has a `command` or a `url` |
| Project servers | `~/.claude.json` `projects[*].mcpServers` | how many, nothing else |
| Plugin servers | `~/.claude/settings.json` `enabledPlugins`, then `~/.claude/plugins/installed_plugins.json` for where each plugin is, then that plugin's `.mcp.json` or `.claude-plugin/plugin.json` | `plugin:<plugin>:<server>` |
| claude.ai connectors | `~/.claude.json` `claudeAiMcpEverConnected` | each name |
| Needs sign-in | `~/.claude/mcp-needs-auth-cache.json` | which names are in it |
| Live state | `claude mcp list` (below) | each line's name and state |
| Codex | `~/.codex/config.toml` | the table headers above and their `enabled` line - no other line is read |
| Tool versions | each program's `--version`; Hermes's own files; a Mac app's `Info.plist` | the number only |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `HERMES_HOME` are honoured.

### The live check: `claude mcp list`

`claude mcp list` asks every server whether it connects. To answer, it **starts every local
server** on its list, and it prints each server's command or address. So the collector:

- runs the `claude` it found itself (below), by its full path - never one inside `--clone`;
- runs it from `<state-dir>/empty-cwd`, emptied first, so no project's own servers or settings load;
- stops it after **2 minutes**, or if it prints more than **256 KB** - and stops everything it
  started with it - and then uses the file list instead, saying why (`live` is `timed out`,
  `could not read`, `could not run` or `program not found`);
- keeps from each line only the name, up to the first `": "`, and the state, after the last
  `" - "`. Everything between - the command, the address - is dropped in memory. Its exit code is
  ignored: it exits 0 even when servers fail;
- adds a server only the live list shows when its name starts `plugin:` or `claude.ai `; any other
  such name could be a project's own server, so it is counted in `hidden`, never named.

On the Mac this runs every three hours with the schedule. A local server that does something when
it starts does it then too.

### Installed tools

Programs are found by the collector's own lookup, not the shell's: only absolute `PATH` entries,
then `~/.local/bin` (where Claude Code installs itself), `~/.claude/local`, and on a Mac
`/opt/homebrew/bin` and `/usr/local/bin`. A program inside `--clone` is refused. On Windows only a
real `.exe` runs: a `.cmd` (how npm installs Codex there) needs a shell, so that tool shows
`could not check`. Each runs from the empty folder for at most 10 seconds.

The collector **never runs `hermes`**: `hermes --version` is not read-only (run once to read its
version, it tried to finish an update instead). Hermes's version is read from
`hermes-agent/pyproject.toml` (or `hermes-agent/hermes_cli/__init__.py`) under `HERMES_HOME`,
`%LOCALAPPDATA%\hermes` on Windows, or `~/.hermes`. On a Mac the Claude, ChatGPT and Tailscale apps
are read from their `Info.plist` with `/usr/bin/plutil`; on Windows the apps say `could not check`.

The student guide is [docs/guides/connections-wall.md](../../docs/guides/connections-wall.md); what
is read and never kept, in detail, is
[docs/guides/connections-wall-how-it-works.md](../../docs/guides/connections-wall-how-it-works.md).

## What is never written

Every file, receipt and printed line passes a safety check (`scripts/lib/status/safe.mjs`) before
it leaves the script. If anything fails it, **nothing is written** and the message names the field,
never the value. These are never written:

- any sign-in token, key or password, and anything shaped like one
- your email address, account id or name
- your username, home folder, or any file path outside this repo
- project folder names, working folders, session ids, or anything you or Claude typed
- the computer name - the label you choose is used instead
- a server's address, command, arguments, environment or headers; a project server's name; a
  plugin's install folder or where it came from beyond its marketplace name; anything a program
  prints around its version number

## Receipts

A `--commit` run takes a lock (so two runs never overlap; a lock over an hour old is from a crash
and is taken over), then claims its occurrence under `<state-dir>/claims/`. With `--clone` (the
schedule) the occurrence is the three-hour slot, named by its New York date and starting hour -
`2026-10-07T15-00-new-york.claim/` covers 15:00 to 18:00 - so a run on waking and a manual
kickstart in the same slot do not both run; the second says so and skips. A run by hand in your
own copy is named after its UTC second instead (`2026-10-07T20-00-00Z.claim/`), so asking again
later always takes a fresh reading. It writes `receipt.json` there once the snapshots are
written - `agent-status/receipt/v2`: the parts, each file with its hash (`files`), and which sources
were found - and `final.json` when it is done: the outcome and the commit id. A claim with a
receipt and no final record means the outcome is unknown; look before running it again.

Every collector commit is titled `Status snapshot from <computer>`. Before there were parts it was
`Usage snapshot from <computer>`; a dedicated clone still treats an unpushed commit with either
title as its own.

## The Mac schedule (phase 4, task T14)

The always-on Mac Mini runs the collector every three hours, America/New_York, as a **GUI
LaunchAgent** - a GUI session is what can read the login Keychain. It uses two folders that
nothing else uses, and never touches anyone's working copy:

- **The code checkout**, `~/.local/share/agent-status/collector-code` - the collector that runs.
  It is pinned to one commit you have read, and it **never updates itself**. You move it by hand.
- **The data clone**, `~/.local/share/agent-status/data` - where the snapshot is written,
  committed and pushed. It is reset to whatever the team repo holds on every run.

Why two: anyone who can push to the team repo - a person, or a cloud agent talked into it -
decides what the data clone holds three hours later. If the code ran from there, they would be
choosing code that runs on the Mac with access to its Keychain. So the code comes from a checkout
only you move, and the collector **refuses to run** if its own code is inside the `--clone` folder.

The same people could commit `.agent-team/status/usage` (or a folder above it) as a link, so
that writing the snapshot "into the clone" writes somewhere else on the Mac. Before reading
anything, and again before every write, the collector checks each part of that path - on disk
and in git - and that the folder really is inside the clone. If any part is a link it **writes
nothing**, says so, and records the run as `failed`. This check runs in every mode.

Git in the data clone never runs hooks either: every git command there is told to look for hooks
in an empty folder the collector owns (`<state-dir>/no-hooks`), so a hook script pushed into the
team repo cannot run on the Mac even if your global git settings point hooks at a folder inside
each repo.

This follows the team's ongoing-task policy: deterministic, no model call, one owner, receipts,
and a rollback.

| Item | Value |
|---|---|
| Task ID | `agent-status-collector` |
| Owner | `~/Library/LaunchAgents/local.donna.agent-status-collector.plist` |
| Cadence | 00:07, 03:07, ... 21:07 Mac local time (the Mac must be set to New York time) |
| Command | `node <code>/scripts/collect-status.mjs --computer "Mac Mini" --commit --clone <data>` |
| Receipts | `~/.local/state/agent-status-collector/claims/<slot>.claim/{receipt,final}.json` |
| Missed runs | Skipped. If the Mac sleeps through a slot, launchd runs once on wake: one fresh reading under a new claim, not a replay |
| Alert | The dashboard's stale banner after 8 hours |
| Rollback | `launchctl bootout`, move the plist out, delete both folders |

### One-time setup

1. Make the code checkout and pin it (replace the two `YOUR-` parts). The pin is the commit
   you have read: `id` holds its id, and the checkout uses that same id.

   ```bash
   mkdir -p ~/.local/share/agent-status
   git clone https://github.com/YOUR-ACCOUNT/YOUR-TEAM-REPO.git ~/.local/share/agent-status/collector-code
   id=$(git -C ~/.local/share/agent-status/collector-code rev-parse origin/main)
   echo "$id"      # read the code at this commit (scripts/ and package.json at least) before going on
   git -C ~/.local/share/agent-status/collector-code -c advice.detachedHead=false checkout "$id"
   ```

   This folder needs no push access and no git name. Nothing writes to it.

2. Make the data clone:

   ```bash
   git clone https://github.com/YOUR-ACCOUNT/YOUR-TEAM-REPO.git ~/.local/share/agent-status/data
   ```

   This one needs push access and a git name and email (`git config user.name` /
   `user.email` inside it).

3. Find node's full path with `which node`, and use it in the plist below.

4. Run it once **by hand in a Terminal on the Mac's screen**, not over SSH:

   ```bash
   node ~/.local/share/agent-status/collector-code/scripts/collect-status.mjs --computer "Mac Mini" --dry-run
   ```

   macOS may ask whether `security` (`/usr/bin/security`) may read "Claude Code-credentials".
   Unattended runs need **Always Allow**. Know what that grants: any program that runs `security`
   as you can then read that one item without asking. (Whether the prompt appears, and for which
   program, is not yet verified on the Mac.)

5. Save this as `~/Library/LaunchAgents/local.donna.agent-status-collector.plist`, replacing
   `YOUR-MAC-USER` and the node path:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.donna.agent-status-collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR-MAC-USER/.local/share/agent-status/collector-code/scripts/collect-status.mjs</string>
    <string>--computer</string>
    <string>Mac Mini</string>
    <string>--commit</string>
    <string>--clone</string>
    <string>/Users/YOUR-MAC-USER/.local/share/agent-status/data</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR-MAC-USER/.local/share/agent-status/collector-code</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOUR-MAC-USER/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>7</integer></dict>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>/Users/YOUR-MAC-USER/.local/state/agent-status-collector/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR-MAC-USER/.local/state/agent-status-collector/launchd.err.log</string>
</dict>
</plist>
```

6. Load it, and run it once now to prove it:

   ```bash
   mkdir -p ~/.local/state/agent-status-collector
   plutil -lint ~/Library/LaunchAgents/local.donna.agent-status-collector.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.donna.agent-status-collector.plist
   launchctl kickstart gui/$(id -u)/local.donna.agent-status-collector
   ls ~/.local/state/agent-status-collector/claims/
   ```

   The newest claim should hold a `final.json` saying `pushed`, and the dashboard should show
   "taken just now on Mac Mini". Then wait for the next scheduled slot and check again. Record
   the task in `donna/control-center/ONGOING-TASKS.md`.

### Updating the collector, on purpose

The code checkout stays on the commit you pinned until you move it. Pushes to the team repo do
not reach the Mac's collector until you have read them. Fetch, take the id of what arrived, read
the **whole** change - not only `scripts/`: `package.json` and any file the scripts load change
what runs too - and then move the pin to that same id:

```bash
git -C ~/.local/share/agent-status/collector-code fetch --quiet origin
id=$(git -C ~/.local/share/agent-status/collector-code rev-parse origin/main)
git -C ~/.local/share/agent-status/collector-code log --oneline HEAD.."$id"   # what arrived
git -C ~/.local/share/agent-status/collector-code diff HEAD "$id"             # read every line
git -C ~/.local/share/agent-status/collector-code -c advice.detachedHead=false checkout "$id"
```

Checking out `"$id"` rather than `origin/main` matters: a fetch between your reading and the
checkout would otherwise move you to code you have not read. If anything in the diff is not what
you expected, do not move the pin. The next scheduled run uses the new code; nothing needs
reloading.

### Rollback

```bash
launchctl bootout gui/$(id -u)/local.donna.agent-status-collector
mv ~/Library/LaunchAgents/local.donna.agent-status-collector.plist ~/Desktop/
rm -rf ~/.local/share/agent-status/collector-code ~/.local/share/agent-status/data
```

The receipts in `~/.local/state/agent-status-collector` are left for the record.

### Not verified yet

These are checked on the first live run on the Mac, not assumed:

- the Keychain item name and whether the one-time "Always Allow" prompt appears
- whether the Keychain item is printed as hex by `security -w` (the collector decodes it if so)
- the first run (2026-10-08) found a sign-in naming a plan but holding no usable key; the new
  reasons say whether it came from the Keychain or the file
- whether the Mac Mini runs Claude Code interactively often enough for the status line tap's
  reading to be under 6 hours old at each scheduled run
- whether the live address answers a request that does not claim to be Claude Code
- whether Claude Code saves its reading in `~/.claude.json` on the Mac
- whether Codex keeps `auth.json` as a file on the Mac, or in a keyring (then the plan says `not found`)
- the team repo name, and push access from the Mac
- how long `claude mcp list` takes with every server on the Mac, whether it writes to
  `~/.claude.json`, the exact state words it prints there, and whether claude.ai connectors appear
  in it from a LaunchAgent
- where Claude Code and Codex are installed on the Mac, and that `~/.local/bin` on the plist's
  `PATH` (or the collector's own lookup) finds them
- where every plugin keeps its servers: some plugins' servers are not listed through
  `installed_plugins.json` at all, and appear only in the live list
- that `/usr/bin/plutil` reads each app's `Info.plist` from a LaunchAgent

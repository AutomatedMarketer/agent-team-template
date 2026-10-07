# Status snapshots

This folder holds small files that describe a computer, written by a script on that computer and
read by the dashboard. The dashboard runs in the cloud and cannot look at your machine, so the
machine writes down what it sees and commits it here.

Phase 4 writes one kind: **usage** - how much of your Claude and Codex plan limits are used, which
plan you are on, and an estimate of how much Claude Code you have been using.

```
.agent-team/status/usage/<computer>.json
```

One file per computer. `<computer>` is the label you give with `--computer`, turned into a file
name: `--computer "Mac Mini"` writes `mac-mini.json`. With no label the file is
`this-computer.json`. The label is never the computer's own name, because a computer's name is
often its owner's name.

## Run it

```bash
npm run collect:status -- --dry-run                       # print the file, write nothing
npm run collect:status -- --computer "Mac Mini"           # write the file here
npm run collect:status -- --computer "Mac Mini" --commit  # write it, commit only it, push
```

| Option | What it does |
|---|---|
| `--computer "<label>"` | The name shown on the dashboard. Letters, numbers and spaces; up to 60 characters |
| `--dry-run` | Prints the file it would write. Writes nothing, commits nothing |
| `--commit` | Writes, commits only the snapshot file (anything else you have staged stays staged), pushes it if that is safe - see below |
| `--clone <dir>` | With `--commit`: work in a dedicated clone instead of this copy (see the Mac schedule below) |
| `--state-dir <dir>` | With `--commit`: where the lock and receipts go. Default `~/.local/state/agent-status-collector` |
| `--only usage` | Only usage exists so far. Connections and Hermes are later phases |

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
- your copy has no remote called `origin`, or has never fetched origin's `main`.

A push in any of those cases would have sent your other work too. When it does push, it pushes
the snapshot's own commit by id (`git push origin <snapshot commit id>:refs/heads/main`), never
HEAD and never a bare `git push`. If a push is refused, it stops and says so. Either way the
snapshot stays committed locally and nothing of yours is touched; push when you are ready.

## The file

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
others are kept. A block holds at most 8 windows. A window may have no `resetsAt` when the reset
time is not known; the dashboard then says so.

`byModel` counts replies per model family. `activity` is always marked `"estimate": true`: it
counts what Claude Code logged on this one computer, and it never turns into a percentage, because
it cannot know what your plan's limit is.

The exact shape, and the contract the dashboard reads it by, are in
`scripts/lib/status/schema.mjs` and `tests/fixtures/usage-parity.json`.

## Where each number comes from

| Number | Source | Labelled |
|---|---|---|
| Claude limits, first choice | The address Claude Code's `/usage` screen calls. The sign-in comes from the Mac Keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json` | `unofficial-live` |
| Claude limits, second choice | The last reading Claude Code saved in `~/.claude.json`, if under 6 hours old | `claude-code-saved` |
| Claude plan | The plan fields of the same sign-in | - |
| Claude activity | Claude Code's session and subagent logs in `~/.claude/projects`, last 15 days | `estimate` |
| Codex limits | The newest reading in Codex's own session logs, `~/.codex/sessions`, up to 7 days old | `codex-session-log` |
| Codex plan | The plan claim inside the Codex sign-in, `~/.codex/auth.json` | - |

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured if you have moved those folders.

Both Claude readings are **undocumented**. Anthropic has not published that address or that saved
field, so the dashboard shows them with an "unofficial" label, and either can stop working
without notice. When that happens the meter says `unavailable` rather than showing an old or
invented number. The collector sends the sign-in token to that one address only, with an honest
`User-Agent: agent-team-collector/1`, never follows a redirect with it, and will **never refresh**
an expired token - refreshing it could sign Claude Code out. An expired token means the live
reading is skipped and the saved one is tried.

It also **never sends the token** when this Node could be talking to something other than the
real address: certificate checks switched off (`NODE_TLS_REJECT_UNAUTHORIZED=0`), extra
certificates trusted (`NODE_EXTRA_CA_CERTS`), or `NODE_OPTIONS` holding `--use-system-ca`,
`--use-openssl-ca`, `--require` / `-r`, `--import`, `--loader` or `--experimental-loader`. The
saved reading is tried instead, and the meter's reason names the setting, never its value.

## What is never written

Every file, receipt and printed line passes a safety check (`scripts/lib/status/safe.mjs`) before
it leaves the script. If anything fails it, **nothing is written** and the message names the field,
never the value. These are never written:

- any sign-in token, key or password, and anything shaped like one
- your email address, account id or name
- your username, home folder, or any file path outside this repo
- project folder names, working folders, session ids, or anything you or Claude typed
- the computer name - the label you choose is used instead

## Receipts

A `--commit` run takes a lock (so two runs never overlap; a lock over an hour old is from a crash
and is taken over), then claims its occurrence under `<state-dir>/claims/`. With `--clone` (the
schedule) the occurrence is the three-hour slot, named by its New York date and starting hour -
`2026-10-07T15-00-new-york.claim/` covers 15:00 to 18:00 - so a run on waking and a manual
kickstart in the same slot do not both run; the second says so and skips. A run by hand in your
own copy is named after its UTC second instead (`2026-10-07T20-00-00Z.claim/`), so asking again
later always takes a fresh reading. It writes `receipt.json` there once the snapshot is
written - which sources were found, the file name and its hash - and `final.json` when it is done:
the outcome and the commit id. A claim with a receipt and no final record means the outcome is
unknown; look before running it again.

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

1. Make the code checkout and pin it (replace the two `YOUR-` parts). Pick the commit to pin:
   the newest one on `main` whose `scripts/` you have read. `git log -1 --format=%H origin/main`
   prints its id.

   ```bash
   mkdir -p ~/.local/share/agent-status
   git clone https://github.com/YOUR-ACCOUNT/YOUR-TEAM-REPO.git ~/.local/share/agent-status/collector-code
   cd ~/.local/share/agent-status/collector-code
   git -c advice.detachedHead=false checkout THE-COMMIT-ID-YOU-READ
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
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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

The code checkout stays on the commit you pinned until you move it. Pushes to the team repo,
including ones that change `scripts/`, do not reach the Mac's collector until you have read them:

```bash
cd ~/.local/share/agent-status/collector-code
git fetch --quiet origin
git log --oneline HEAD..origin/main -- scripts/          # what changed in the collector
git diff HEAD origin/main -- scripts/                    # read every line of this
git -c advice.detachedHead=false checkout THE-NEW-COMMIT-ID
```

If anything in that diff is not what you expected, do not move the pin. The next scheduled run
uses the new code; nothing needs reloading.

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
- whether the live address answers a request that does not claim to be Claude Code
- whether Claude Code saves its reading in `~/.claude.json` on the Mac
- whether Codex keeps `auth.json` as a file on the Mac, or in a keyring (then the plan says `not found`)
- the team repo name, and push access from the Mac

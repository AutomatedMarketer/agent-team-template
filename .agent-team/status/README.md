# Status snapshots

This folder holds small files that describe a computer, written by a script on that computer and
read by the dashboard. The dashboard runs in the cloud and cannot look at your machine, so the
machine writes down what it sees and commits it here.

It writes four kinds, called **parts**:

- **usage** (Phase 4) - how much of your Claude and Codex plan limits are used, which plan you are
  on, and an estimate of how much Claude Code you have been using.
- **connections** (Phase 5) - the Connections wall: which tools are installed and their versions,
  and which Claude Code and Codex servers and plugins this computer has, and whether each one
  connects. **Names only** - see [The connections file](#the-connections-file).
- **hermes** (Phase 6) - the Hermes card: Hermes's version, whether its gateway and scheduler are
  beating, and per profile the model, how many skills, and how many conversations and scheduled
  runs in the last week. **Counts, times and names only** - see [The Hermes file](#the-hermes-file).
- **jobs** - the Readiness wall: every scheduled job on this computer, one row each - the Mac's
  LaunchAgents and Hermes's cron jobs - with how it is scheduled, when it last reported and when it
  should have. **Names, schedules, times and states only** - see [The jobs file](#the-jobs-file).

```
.agent-team/status/usage/<computer>.json
.agent-team/status/connections/<computer>.json
.agent-team/status/hermes/<computer>.json
.agent-team/status/jobs/<computer>.json
runs/heartbeat/hermes.json                       (only when Hermes is alive - see below)
```

One file per part per computer. `<computer>` is the label you give with `--computer`, turned into a
file name: `--computer "Mac Mini"` writes `mac-mini.json`. With no label the file is
`this-computer.json`. The label is never the computer's own name, because a computer's name is
often its owner's name.

A run collects every part unless `--only` picks some. The parts travel together: every part passes
the safety check before **any** file is written, and `--commit` puts all of them in one commit -
except that a refused jobs file is written as unavailable instead (see [The jobs file](#the-jobs-file)).

## Run it

```bash
npm run collect:status -- --dry-run                       # print the files, write nothing
npm run collect:status -- --computer "Mac Mini"           # write the files here
npm run collect:status -- --computer "Mac Mini" --commit  # write them, commit only them, push
npm run collect:status -- --only connections --dry-run    # one part only
npm run collect:status -- --only hermes --dry-run         # the Hermes card only
npm run collect:status -- --only jobs --dry-run           # the Readiness wall's jobs only
```

| Option | What it does |
|---|---|
| `--computer "<label>"` | The name shown on the dashboard. Up to 60 characters: letters, numbers, spaces and `. , ' ’ ( ) + & : _ -` only, no stretch of 24 or more without a space, and not this computer's own name |
| `--dry-run` | Prints the files it would write. Writes nothing, commits nothing |
| `--commit` | Writes, commits only the snapshot files, in one commit (anything else you have staged stays staged), pushes it if that is safe - see below |
| `--clone <dir>` | With `--commit`: work in a dedicated clone instead of this copy (see the Mac schedule below) |
| `--state-dir <dir>` | With `--commit`: where the lock and receipts go. Default `~/.local/state/agent-status-collector`. The empty folder programs run from, `empty-cwd`, and the private copies of Hermes's sessions are made here too. Refused (exit 2) when it is inside the `--clone` folder |
| `--only usage,connections,hermes,jobs` | Only these parts, in any order: one, two, three or all four |

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

## The Hermes file

What the Hermes card at the top of Connections shows. **Counts, times, states and names only.** The
collector **never runs `hermes`** - not even `hermes --version`, which is not read-only - and it
never starts any program for this part: everything comes from Hermes's own files.

```json
{
  "schema": "agent-status/hermes/v1",
  "takenAt": "2026-10-08T15:00:00Z",
  "computer": "Mac Mini",
  "install": { "status": "found", "version": "0.21.3", "updateAvailable": true },
  "gateway": { "status": "found", "state": "running", "beatAt": "2026-10-08T14:59:12Z" },
  "profiles": {
    "status": "found",
    "items": [
      {
        "name": "default", "model": "claude-opus-5-5", "provider": "anthropic",
        "skills": { "status": "found", "count": 89 },
        "sessions": { "status": "found", "days": 7, "conversations": 14, "scheduled": 21, "lastActiveAt": "2026-10-08T14:40:00Z" },
        "scheduler": { "status": "found", "beatAt": "2026-10-08T14:59:30Z" }
      },
      {
        "name": "coder",
        "skills": { "status": "not found" },
        "sessions": { "status": "unavailable", "why": "needs a newer Node" },
        "scheduler": { "status": "not found" }
      }
    ],
    "hidden": 1, "more": 0
  }
}
```

Hermes's home is found the way Hermes finds it: `HERMES_HOME` (when it points at one profile,
`<root>/profiles/<name>`, the root is used), else `%LOCALAPPDATA%\hermes` on Windows, else
`~/.hermes`. If there is no Hermes at all, `install`, `gateway` and `profiles` are each
`not found` and nothing else is written.

| What | Read from | Kept |
|---|---|---|
| Version | `hermes-agent/pyproject.toml` (`[project]` `version`), else `hermes-agent/hermes_cli/__init__.py` (`__version__`) | the number |
| Update available | `.update_check`, Hermes's own check | `true` or `false`, only when the check is under 7 days old and was made for the version installed |
| Gateway | `gateway_state.json` | `gateway_state` (as `state`: `starting`, `running`, `degraded`, `stopped`, `startup_failed`, else `unknown`) and `updated_at` (as `beatAt`) |
| Profiles | the home itself (`default`, always first), then each folder in `profiles/` that Hermes would list, A to Z, at most 12 profiles | the name, when it passes the name rule; otherwise counted in `hidden`. Past 12, counted in `more` |
| Model | each profile's `config.yaml`: the top-level `model` block's `model.default` and `model.provider` only | the model's last part after the last `/` (`anthropic/claude-opus-5-5` is `claude-opus-5-5`), and the provider - each only if it passes the name rule - never `base_url` or any other key |
| Skills | each profile's `skills/` folder, at any depth | how many files are named `SKILL.md`. None is opened |
| Sessions | a **private copy** of each profile's `state.db` (and `state.db-wal`), asked through `node:sqlite` | how many top-level sessions started in the last 7 days - `conversations` (every source but `cron`, `delegate` and `subagent`) and `scheduled` (`cron`) - and when the newest was last active |
| Scheduler | each profile's `cron/ticker_heartbeat` | the time in it |

Hermes keeps `state.db` in WAL mode, and SQLite makes `state.db-wal` and `state.db-shm` beside a
WAL database for any connection - even a read-only one - and can leave them there. So the collector
**never opens Hermes's own file**. It copies `state.db`, and `state.db-wal` when there is one (it
holds the newest sessions), into a new folder under its state folder (`<state-dir>/hermes-db-...`) -
never `state.db-shm` - asks the copy, and deletes that folder whatever happens. Hermes's folder is
left exactly as it was. Above 200 MB nothing is copied, and sessions say `unavailable` ("database
too big").
If a run crashes before it deletes its copy, the next run removes it: at the start of every run,
any `hermes-db-...` folder in the state folder older than an hour is deleted - only real folders
with that name, never a link, and never one younger, which may be another run's.

Sessions are one fixed question. The collector first asks which columns the `sessions` table has
(`PRAGMA table_info`), then asks one `SELECT` built only from fixed words - never from anything read
from the file. A table missing an optional column (`parent_session_id`, `last_activity_at`,
`ended_at`) still answers; one missing `source` or `started_at` is `unavailable` ("not a layout this
collector knows"). With no `node:sqlite` (Node 20, or Node 22 before 22.13) it is `unavailable`
with "needs a newer Node" - **never 0**.

**Checked to exist:** the files that make a folder a profile - `config.yaml`, `.env`, `SOUL.md`,
`profile.yaml`, `auth.json`, `state.db` - and a profile's tombstone in `profiles/.deleted/`. Of
these only `config.yaml` (its model lines) and `state.db` (copied, above) are ever read. **Never touched:** `.env`, `auth.json`, `SOUL.md` and `USER.md` contents,
`memories`, `logs`, sessions' titles, folders and chat content, the gateway's `pid`, `argv` and
chat apps, and everything else in the home.

**Alive.** The file never says whether Hermes is alive. The dashboard works it out from the times
in it: Hermes is **Running** when the gateway's state is `running` and its `beatAt` is within
5 minutes of `takenAt`, or when any listed profile's scheduler `beatAt` is within 5 minutes of
`takenAt`. Otherwise it is **Down at last check**; and a file older than 8 hours says **Not
checked for N h** instead. The rule, with worked examples, is in `tests/fixtures/hermes-parity.json`.

**Heartbeat.** When - and only when - that rule holds, the collector also writes
`runs/heartbeat/hermes.json`, `{ "runtime": "hermes", "at": <the newest time that proved it> }`, in
the same commit and behind the same link checks as the status files. When Hermes is down it writes
no heartbeat and leaves the old one as it is, so the dashboard sees it go stale. The collector runs
every three hours, so a Hermes entry in `runtimes.yml` needs `stale_after_minutes: 200` (three
hours and twenty minutes) - see `runtimes.yml`.

The contract the dashboard reads this by is `scripts/lib/status/hermes-schema.mjs` and
`tests/fixtures/hermes-parity.json`: the states and their words, the cap, the alive rule, the
heartbeat settings, accept and refuse examples for profile, model and provider names, a full
sample, and the shape the board builds from it.

If writing fails before any file is in place, it says **Nothing was written** and leaves no file.
If it fails after some files were already renamed into place, it says **Some snapshot files may
have been written; check .agent-team/status and runs/heartbeat** - run it again to put every file
back in step.

## The jobs file

What the Readiness wall shows: every scheduled job on this computer - the Mac's LaunchAgents and
Hermes's cron jobs - one row each, with how it is scheduled, how its last run went, and when it
should have last run. **Names, schedules, times and states only.** On a Mac the collector runs two
short programs for this, `/usr/bin/plutil` and `/bin/launchctl list`. It **never runs `hermes`**,
and it starts no program for Hermes at all: everything comes from Hermes's own files.

```json
{
  "schema": "agent-status/jobs/v1",
  "takenAt": "2026-10-09T15:00:00Z",
  "computer": "Mac Mini",
  "timezone": "America/New_York",
  "launchd": {
    "status": "found",
    "items": [
      {
        "label": "local.donna.story-belt-daily",
        "cadence": { "kind": "slots", "slots": [{ "minute": 15, "hour": 6 }] },
        "state": "loaded", "lastExit": 0, "lastReportAt": "2026-10-09T10:15:22Z",
        "dueAt": "2026-10-09T10:15:00Z", "dueBeforeAt": "2026-10-08T10:15:00Z"
      },
      { "label": "local.donna.security-changelog", "cadence": { "kind": "always" }, "state": "running" }
    ],
    "hidden": 1, "more": 0
  },
  "hermes": {
    "status": "found",
    "items": [
      {
        "profile": "default", "id": "a1b2c3d4e5f6", "name": "Hermes job a1b2c3d4e5f6", "enabled": true,
        "cadence": { "kind": "slots", "slots": [{ "minute": 30, "hour": 6 }] },
        "lastRunAt": "2026-10-09T10:30:04Z", "lastResult": "ok",
        "dueAt": "2026-10-09T10:30:00Z", "dueBeforeAt": "2026-10-08T10:30:00Z"
      }
    ],
    "hidden": 0, "more": 0
  }
}
```

| What | Read from | Kept |
|---|---|---|
| LaunchAgents | the plists in `~/Library/LaunchAgents` - the user's own folder, **never `/Library`** - turned into JSON by `/usr/bin/plutil`, in memory, from the empty folder | `Label`, `StartCalendarInterval`, `StartInterval`, `KeepAlive`, `RunAtLoad`, `Disabled`. The rest of the plist is dropped the moment these are taken |
| Loaded or not | `/bin/launchctl list` | `running` (it has a process), `loaded` (listed, no process), `not loaded` (not listed); and the last exit status (-255 to 255) of a job it lists |
| When it last reported | the two log files the plist names (`StandardOutPath`, `StandardErrorPath`) | their newest **modified time**. The files are never opened, so what a job printed cannot be read, and their paths are not kept |
| The collector's own row | `XPC_SERVICE_NAME`, which launchd sets to the label of the job it runs | `self: true` on that row |
| Hermes jobs | `cron/jobs.json` in the Hermes home and in each profile - up to 1 MB each. It is one JSON file, so it is parsed whole in memory; only the keys named here are then used | the job's `id` (it is published as `Hermes job a1b2c3d4e5f6`, never under the name the file gives it), whether it is on (`enabled`, and whether `state` or `paused_at` marks it paused), its `schedule` (`kind`, `expr`, `minutes`, `timezone`: a cron expression, or an interval in minutes), when it last ran (`last_run_at`) and how it ended (`last_status`) |
| Hermes's timezone | each profile's `config.yaml`: the top-level `timezone:` line, and no other line | nothing is written: the zone is only compared with the computer's, to decide whether a cron time can be judged |

A Hermes job's `last_status` is written as `ok`, `error` or `unknown` and nothing more. The words are
the ones Hermes itself writes: `ok` (the run succeeded and its output was delivered); `error` (it
failed), `delivery_failed` (it ran but its output could not be delivered), `blocked_config` (it was
stopped before running because of a wrong setting) and `interrupted` (a shutdown cut it off) all
become `error`, in any case; every other word, and no word, is `unknown` - never green on a word
nobody has checked. Hermes keeps the reason; it is never kept here.

**How a job is scheduled** - its `cadence`, one of four kinds:

| Kind | When | Written as |
|---|---|---|
| `always` | a LaunchAgent with `KeepAlive` set to true, or with `RunAtLoad` true while it has a process. An agent that runs once at login and exits is finished, not down, so it is `unknown` and its light comes from how it last ended | nothing more |
| `every` | a `StartInterval` (seconds, rounded to whole minutes, at least one), a cron minute step that divides the hour (`*/15 * * * *`), or a Hermes `interval` job (its `minutes`) | the number of minutes |
| `slots` | `StartCalendarInterval` entries, or a cron expression with lists, ranges and steps for minute, hour and weekday and a single day of the month - at most 48 slots | each slot: a minute, and optionally an hour, a weekday (0 is Sunday) or a day of the month |
| `unknown` | anything else | nothing more |

A schedule is `unknown`, never guessed, when it has a month; a day of the month together with a
weekday (cron says "or", launchd does not say; for cron it counts whenever both are written - neither
is a bare `*` - even a weekday range that covers every day, because `0 9 1 * 0-6` runs daily, not on
the 1st); a calendar entry with no minute (that means every
minute); both a calendar and an interval; a `KeepAlive` that is a condition (restart on failure,
while the network is up); more than 48 slots; for a Hermes job, a kind other than `cron` or `interval`,
a cron expression that is not five plain fields (names and nicknames such as `MON` or `@daily` are not
read), or a time zone other than the computer's. Hermes reads a cron expression in the zone set by the
`timezone:` line of the profile's `config.yaml` (or by `HERMES_TIMEZONE` in its own environment, which the
collector cannot see), else in the computer's own time; a cron job whose profile names another zone,
or that names one itself, is `unknown` rather than judged at the wrong hour. An interval has no wall
clock, so it needs no zone.

**When it should have run.** For a job with a schedule the Mac works out `dueAt` and `dueBeforeAt`:
the two most recent times it was expected to run, at or before the check time minus 30 minutes (the
grace for a run that has only just started), in the job's own timezone, looking back 32 days. The
board compares them with the last report; the file **never says whether a job is on time or late**.
When the clocks jump forward, a time that does not exist that day is skipped; when they go back, a
time that happens twice takes the earlier one. An `every` job's start is not known, so its times are
placed N and 2N minutes before the limit. A job with an `always` or `unknown` schedule, and a job
that is switched off, has no due times, and `dueBeforeAt` is also left out when fewer than two
expected runs fall in the 32 days (a monthly job often has only one, and a job that runs only on the
31st can have none: its `dueAt` is left out too).

**Switched off.** A LaunchAgent is `disabled: true` when its plist says `Disabled` and `launchctl`
does not list it (a loaded job is on). A Hermes job is `enabled: false` when its `enabled` is false -
as Hermes reads it, a record with no `enabled` key is on - or when it has a pause marker, because
Hermes does not fire a job whose `state` is `paused`, or that has a `paused_at` time, even if it says
`enabled` - or when it runs once (`once`, or `at`): a one-shot has no schedule to keep checking.

**A Hermes job's name.** A Hermes job's stored name is never published. Hermes copies the first 50
characters of the prompt into the name of a job nobody named, and does not rename the job when its
prompt is edited, so a stored name can carry a prompt that is written nowhere else - and nothing on the
Mac can tell which names are like that. So every Hermes job is published as `Hermes job a1b2c3d4e5f6`,
with its own 12-character id, and the gate refuses any other name. A job's name, prompt, skills and
script are not used, kept or written, in any form - not whole, not shortened, not hashed. (The jobs file
is one JSON file, so it is parsed whole in memory; the collector then uses only the keys in the table.)
You give a job a friendly name yourself, below.

### How to name your Hermes jobs on the board

The wall shows each Hermes job as `Hermes job` and its id until you name it. The id is the 12-character
code Hermes gave the job, the part after `Hermes job `.

1. Ask Claude, in the team repo: "call the Hermes job a1b2c3d4e5f6 'YouTube morning brief'". Say which
   profile it is in; the main one is `default`.
2. Claude adds an entry to `jobs.yml` with the id `hermes:<profile>/<id>` - for the main profile,
   `hermes:default/a1b2c3d4e5f6` - and a `name:`, and commits it.
3. The board applies the name the next time it loads.

This is the same on Windows and on a Mac: `jobs.yml` is a text file in the team repo, so there is
nothing to install and no command to run. The name lives in the team repo, where you wrote it on
purpose; the collector never reads it. To keep a job off the wall instead, ask Claude to add
`hide: true` to its entry.

**Names of the rest.** A LaunchAgent's label and a Hermes job's id must pass the same name rule as the
Connections wall (no at sign, slash, key, token start, id, long unbroken run, and not this computer's
username or name), and also letters, numbers and `.` `-` `_` only. A Hermes job's name is made from its
id, so it must pass too: after the 11 characters of `Hermes job ` the id can be 49 characters at most,
and a name is 60 at most. One that fails is **not written**: it is counted in `hidden`, so the wall can
say "n jobs not shown". The name rule refuses anything with `sk-` in it, because that is how a key starts, so a job
called `task-runner`, `desk-helper` or `risk-monitor` is withheld too. It is counted in `hidden`, in the
file and in the log line, so the dashboard can say how many jobs hidden by the safety rule there are;
the rule is shared with the whole dashboard and is not loosened. Renaming it in `jobs.yml` cannot help,
because the collector refuses the name before anything is written and the dashboard never sees it:
rename the LaunchAgent where it is made (its label). A jobs file or plist
that cannot be read counts as one. At most 60 LaunchAgents and 40
Hermes jobs are written (the first by label, or by profile and id) and at most 200 plists are
read; the rest are counted in `more`. The file stays under 64 KB: if it ever would not, the biggest
schedules are given up first (the job stays, its schedule `unknown`).

**Without a Mac, without Hermes, without a known timezone.** Off a Mac, `launchd` is `not found`
and no program runs. With no Hermes, `hermes` is `not found`. If the computer's timezone is not one
this runtime knows, the file says `UTC`, still lists every schedule, and writes no due times.

**If the safety check refuses the jobs file**, the other three files are still written. The jobs part
reads the most unfamiliar files, so it is the one part whose refusal does not stop the run: its file is
replaced by one that says both blocks `unavailable` with the reason `refused by the safety check`
(`UTC` as the zone, and nothing from the refused file). The run prints "The jobs file was refused by the
safety check" with the fields that failed - the field, never the value - and ends with exit code 0; the
receipt records `unavailable` for both blocks. Every other part keeps its rule: if one of them is
refused, nothing is written.

A file older than 8 hours is shown as "not checked since", never as a light. A job can be renamed
or hidden on the wall by asking Claude to edit `jobs.yml` in the team repo; the dashboard never
writes it.

The contract the dashboard reads this by is `scripts/lib/status/jobs-schema.mjs` and
`tests/fixtures/jobs-parity.json`: the caps, the cadence kinds and bounds, accept and refuse
examples for labels, the schedule examples (cron, calendar, interval), the due times for the days the
clocks change, and a full sample.

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
- from Hermes: its memories, `SOUL.md`, `USER.md`, `.env`, `auth.json` and logs (never opened);
  session titles, working folders, users, chat ids or any chat content; the gateway's command line
  (`argv`) and process id, and which chat apps it serves; any `config.yaml` key but
  `model.default` and `model.provider` (and, for the jobs part, the one `timezone:` line) - never
  `base_url`; a profile or model name that fails the
  name rule
- from jobs: a LaunchAgent's program and its arguments (`ProgramArguments`), its environment
  (`EnvironmentVariables`), its folders (`WorkingDirectory`) and every other key of its plist; the
  contents of its logs, which are never opened; a Hermes job's name, prompt, skills and script, which are not used, kept or written
  (a Hermes job is published as `Hermes job <id>`); where a job
  delivers or came from, its model, `last_error` and every other word of error text; a
  label or id that fails the name rule

## Receipts

A `--commit` run takes a lock (so two runs never overlap; a lock over an hour old is from a crash
and is taken over), then claims its occurrence under `<state-dir>/claims/`. With `--clone` (the
schedule) the occurrence is the three-hour slot, named by its New York date and starting hour -
`2026-10-07T15-00-new-york.claim/` covers 15:00 to 18:00 - so a run on waking and a manual
kickstart in the same slot do not both run; the second says so and skips. When the code checkout
is a git checkout, the claim also carries the first 12 characters of its commit
(`2026-10-07T15-00-new-york-code-35cd2871a0b4.claim/`), so after you move the pin a kickstart
runs the new code once, even in a slot the old code already used. A run by hand in your
own copy is named after its UTC second instead (`2026-10-07T20-00-00Z.claim/`), so asking again
later always takes a fresh reading. It writes `receipt.json` there once the snapshots are
written - `agent-status/receipt/v2`: the parts, each file with its hash (`files`, which includes
`runs/heartbeat/hermes.json` when it was written), and which sources were found (for Hermes:
install, gateway and profiles, and whether a heartbeat was written; for jobs: launchd and Hermes statuses and how many jobs were listed) - and `final.json` when it is
done: the outcome and the commit id. A claim with a
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
| Receipts | `~/.local/state/agent-status-collector/claims/<slot>[-code-<commit>].claim/{receipt,final}.json` |
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

   To see the Hermes card on its own first: `... --only hermes --dry-run`. Its log lines say
   whether the version, gateway and profiles were found, how many sessions were read, and whether
   Hermes counted as alive - never a profile or model name. The plist below needs no change for
   Hermes: a run with no `--only` collects every part.

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

### What changes when you move the pin to this version

The plist runs the collector with **no `--only`**, so it collects **every part** the code it runs
knows. A pin still on the Phase 4 code collects usage only. Moving the pin to this version adds three
parts to every scheduled run, with nothing changed in the plist:

| Part | What starts happening every 3 hours |
|---|---|
| **connections** | It reads Claude Code's and Codex's settings files for names, and **runs `claude mcp list`** from the empty folder, which **starts every local server** on that list and asks every web server to connect - up to 2 minutes. It also runs `--version` for Claude Code, Codex, Git, GitHub CLI and Tailscale, and reads the apps' `Info.plist`. |
| **hermes** | It reads Hermes's files under `~/.hermes` (version, gateway and scheduler times, each profile's model lines and skill count) and copies each profile's `state.db` into `<state-dir>/hermes-db-...` to count sessions, then deletes the copy. It runs nothing. When Hermes is alive it also commits `runs/heartbeat/hermes.json`. |
| **jobs** | It reads the plists in `~/Library/LaunchAgents` through `/usr/bin/plutil` and asks `/bin/launchctl list` which are loaded - two short programs, from the empty folder - and looks at the modified time of each job's log files. It reads Hermes's `cron/jobs.json` files and starts nothing for Hermes. |

Nuno approved the live check every 3 hours (decision D1). Whether `claude mcp list`, run from the
empty folder, records that folder as a project in `~/.claude.json` is **not verified yet** (below).
Look after the first run: if `~/.claude.json` gains a project for
`~/.local/state/agent-status-collector/empty-cwd`, that is the live check.

**To keep a part out**, name the parts you want with `--only` in the plist's `ProgramArguments`,
after `Mac Mini`:

```xml
    <string>--computer</string>
    <string>Mac Mini</string>
    <string>--only</string>
    <string>usage,hermes</string>
```

`usage,hermes` leaves out the connections part and the jobs part, and with the connections part
`claude mcp list`; `usage,connections,hermes` leaves out only the jobs part; `usage,connections`
leaves out Hermes and the jobs; `usage` is the Phase 4 behaviour. After editing the plist, reload it:
`launchctl bootout gui/$(id -u)/local.donna.agent-status-collector`, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.donna.agent-status-collector.plist`.
A part left out keeps its last file on the dashboard until that file goes stale (8 hours).

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
  `~/.claude.json` - in particular whether it records the empty folder
  (`~/.local/state/agent-status-collector/empty-cwd`) as a project there every 3 hours - the exact
  state words it prints there, and whether claude.ai connectors appear in it from a LaunchAgent
- where Claude Code and Codex are installed on the Mac, and that `~/.local/bin` on the plist's
  `PATH` (or the collector's own lookup) finds them
- where every plugin keeps its servers: some plugins' servers are not listed through
  `installed_plugins.json` at all, and appear only in the live list
- that `/usr/bin/plutil` reads each app's `Info.plist` from a LaunchAgent
- Hermes on the Mac: that it lives in `~/.hermes` (no `HERMES_HOME` in the plist), its version and
  `hermes-agent/pyproject.toml`, which profiles it has, whether `gateway_state.json`, each
  profile's `state.db` and `cron/ticker_heartbeat` are there and in the shape read here, and how
  often the gateway re-stamps its file. All of this was read from the Hermes source and the Windows
  PC's copy only
- jobs on the Mac: that launchd sets `XPC_SERVICE_NAME` to the collector's label when it runs the
  schedule (it is how the collector's own row is marked `self`); that `launchctl list`, run from the
  collector's LaunchAgent, lists the same agents you see in a Terminal, and that the long-running
  owners with `RunAtLoad` show a process; and that each calendar job writes its log file on every
  run, because the log file's modified time is its last report (a job with no log has none)
- jobs in Hermes: the schedule kinds (`cron`, `interval`, `once`; the plan said `at`, which is also
  read), Hermes job ids (12 hex characters), the `enabled` default and the `last_status` words (`ok`,
  `error`, `delivery_failed`, `blocked_config`, `interrupted`) were read from Hermes's own source on
  the Windows PC (`cron/jobs.py`, `cron/scheduler.py`, `hermes_time.py`), not from a jobs file on the
  Mac - the Mac's Hermes may be another version, so check its `schedule.kind` values and
  `last_status` words with a read-only look; whether `HERMES_TIMEZONE` is set in the Mac's Hermes
  environment (the collector cannot see it, and reads cron times in the computer's zone when the
  profile's `timezone:` line is absent); that `last_run_at`, which Hermes stamps when a run
  completes, is the finish and not the start; and whether any job name has a dash, a slash or more
  than 60 characters - those jobs are counted in `hidden`, not shown
- how many of the Mac's Hermes jobs are enabled but paused (written off, as Hermes does not fire them)
- which of the Mac's LaunchAgents use a `KeepAlive` that is a condition rather than plain `true`:
  those are read as an unknown schedule; and how many agents with `RunAtLoad` or `WatchPaths` are
  loaded but not running - they are read as an unknown schedule, so a crash shows through the
  non-zero exit status, not through a missing process
- the Mac's Node version: session counts need `node:sqlite` (Node 22.13 or newer); older says
  "needs a newer Node"
- that a copy of `state.db` and `state.db-wal` taken while Hermes is writing reads cleanly: a
  checkpoint between the two copies can make the copy miss the newest sessions, or say
  `could not be read` that run

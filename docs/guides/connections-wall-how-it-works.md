# How the Connections wall works

The student guide is [The Connections wall on your dashboard](connections-wall.md). This page is the
technical side: every file the collector reads for the wall, what it keeps from each, the one
program it runs that does real work, and what is never kept.

---

## The data flow

```
your computer                                         the cloud
-------------                                         ---------
~/.claude.json, plugins, ~/.codex/config.toml  --+
claude mcp list (live)                           +-> collector -> safety check -> connections/<computer>.json
--version of each tool, Hermes's files         --+                                   |  git push
                                                                                     v
                                                         team repo  ->  dashboard (Connections wall)
```

The collector is `scripts/collect-status.mjs`. The wall is its **connections** part; the usage
meters are its **usage** part. One run writes both unless `--only` picks one, and `--commit` puts
both files in one commit. The dashboard runs in the cloud and cannot look at your computer, so the
computer writes down what it sees, by name only.

**Found never becomes proved.** The wall lists what this computer has. A connection is **Proved**
only when your connections register says so - an entry with a `verified` date and a `proof` that a
person wrote after testing it. The board matches the two by name; nothing the collector writes can
mark anything proved.

---

## Every file it reads

| Source | File | Kept | Never kept |
|---|---|---|---|
| Your servers | `~/.claude.json` → `mcpServers` | each key (the name); `local` or `web` from whether the entry has a `type`, `command` or `url` key | the address, command, arguments, environment, headers - the values are never looked at |
| Project servers | `~/.claude.json` → `projects[*].mcpServers` | how many | counted, never named: the names, like the project folders, are often a client's |
| claude.ai connectors | `~/.claude.json` → `claudeAiMcpEverConnected` | each name, as **Seen before** | - |
| Needs sign-in | `~/.claude/mcp-needs-auth-cache.json` | which names are in it | the times |
| Plugins switched on | `~/.claude/settings.json` → `enabledPlugins` | which keys are `true` | every other setting |
| Where each plugin is | `~/.claude/plugins/installed_plugins.json` | the install folder, in memory, for plugins installed for the whole user | the folder (it holds your username), versions, dates |
| Plugin servers | the plugin's `.mcp.json`, or `.claude-plugin/plugin.json` → `mcpServers` (inline, or a path to a file **inside** the plugin's folder) | `plugin:<plugin>:<server>` | as for your servers |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<name>]` and `[plugins."<name>@<from>"]` headers, and the `enabled = true/false` line under each | every other line: commands, `env_vars`, URLs, `[hooks...]` tables (which hold folder paths), projects |
| Tool versions | each program's `--version` (`tailscale version`) | the first number with one to three dots | the rest of what it prints |
| Hermes version | `hermes-agent/pyproject.toml` (`version` under `[project]`), or `hermes-agent/hermes_cli/__init__.py` (`__version__`) | the number | every other line. Everything else Hermes has is the Hermes card's - see [The Hermes card](#the-hermes-card) |
| Mac app versions | `/Applications/<App>.app/Contents/Info.plist`, read by `/usr/bin/plutil` | `CFBundleShortVersionString`, as a number | - |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `HERMES_HOME` are honoured.

Every name is held to the **connection-name rule** before it is kept: the dashboard's characters
(letters, numbers, spaces and `. , ' ’ ( ) + & : _ -`), at most 60 of them, none of `@ / \ eyJ sk-
bearer`, no id, nothing of yours (username, computer name, home folder), and no stretch of 24 or
more characters between `:` `.` `_` `-` or a space. A name that fails is dropped and counted in
`hidden`. Past the caps (100 Claude servers, 50 Codex servers, 60 Codex plugins) the rest are
counted in `more`. Names are sorted, so an unchanged computer writes the same file and commits
nothing.

The TOML file is read as lines, not parsed: a header line is matched, and only an `enabled` line
under one of the two kinds of header is read. Lines inside a multi-line string are skipped, so text
inside a hook's command can never pass for a header.

---

## The live check

`claude mcp list` is the only way to know whether a server actually connects. It is also the
loudest thing the collector does: to answer, it **starts every local server** it lists, and it
prints each server's command or address. So:

- **The program.** The `claude` the collector found itself (next section), by its full path.
- **The folder.** It runs from `<state-dir>/empty-cwd`, emptied first. Started inside a project, it
  would load that project's own servers and settings.
- **The limits.** At most **2 minutes** and **256 KB** of output. When either is hit, the program
  **and everything it started** are stopped - its whole process group on a Mac or Linux, its whole
  process tree on Windows - and the wall shows the file list with a reason.
- **The exit code** is ignored. It exits 0 even when servers fail; each line says how that server did.
- **What is kept.** Colour codes and terminal links are stripped. From each line, the name - up to
  the first `": "` - and the state - after the last `" - "`. Everything between, the command or the
  address, is dropped in memory. State words are matched loosely: connected, needs authentication,
  failed, pending approval; anything else is **Unknown**.
- **The merge.** Live states replace the file states for every name the files listed. A name only
  the live list has is added when it starts `plugin:` (some plugins' servers are not reachable
  through `installed_plugins.json`) or `claude.ai `. Any other such name could still be a project's
  own server, so it is counted in `hidden`, never named.
- **When it does not run.** Without Claude Code's files nothing is started. Without the `claude`
  program the wall says **Claude Code not found**.

On the always-on Mac this runs with the schedule, every 3 hours.

---

## Programs, and how they are found

Every program the collector runs goes through one door, `deps.exec`, built in
`scripts/lib/status/machine.mjs`. It is the only module of the collector that may start a program,
and the tests replace it.

- **Our own lookup, not the shell's.** Only absolute `PATH` entries (`.` and relative entries are
  skipped), then the folders installers use: `~/.local/bin` (where Claude Code installs itself),
  `~/.claude/local`, and on a Mac Homebrew's `/opt/homebrew/bin` and `/usr/local/bin`. A
  LaunchAgent's `PATH` often has none of these, which is why the Mac schedule file now adds
  `~/.local/bin` too.
- **Never inside `--clone`.** The data clone holds whatever the team repo holds; a program found
  there, even through a link, is refused.
- **On Windows, `.exe` only.** A `.cmd` or `.bat` (how npm installs Codex there) needs a shell to
  run, and a shell is one more program reading our arguments. Those tools say **Could not check**.
- **Absolute path, empty folder, a time limit.** Ten seconds and 16 KB for a version check.
- **Hermes is never run.** `hermes --version` is not read-only: run once while this was planned,
  it tried to finish an interrupted update and rewrote one of its own files. The version comes
  from its files instead, under `HERMES_HOME`, `%LOCALAPPDATA%\hermes` on Windows, or `~/.hermes`.
- **The Mac apps** (Claude, ChatGPT, Tailscale) are read from their `Info.plist` with
  `/usr/bin/plutil`, never launched. On Windows the apps say **Could not check**.

---

## What is never kept

The same gate as the usage meters (`scripts/lib/status/safe.mjs`) checks the connections file, the
receipt and every printed line. Allowed keys only - a server entry has `name`, `scope`, `transport`
and `state`, and nothing else can be written. **It fails closed**: one problem in any part and no
file is written, and the message names the field, never the value.

The contract with the dashboard is `scripts/lib/status/connections-schema.mjs` and
`tests/fixtures/connections-parity.json` - the same bytes in the dashboard's repo. It holds every
word the wall shows, the caps, the name rule with examples both sides must agree on, a full sample
file, and the exact shape the board must build from it.

The tests that hold all of this:

- `tests/status-connections-contract.test.mjs` - the contract, the name rule and the gate.
- `tests/status-connections-files.test.mjs` - every file above, from a hostile home full of keyed
  addresses, tokens in arguments, environment and headers, and a Codex config with hooks; none of
  it reaches the file or the log.
- `tests/status-claude-live.test.mjs` - the live check, from a fixture answer full of commands and
  tokens. The real command is never run by the tests.
- `tests/status-tools.test.mjs` - versions as numbers only, and Hermes never run.
- `tests/status-programs.test.mjs` - the lookup, the empty folder, the time limit and output cap
  stopping a whole process tree, and that only `machine.mjs` starts programs.
- `tests/status-parts.test.mjs` - all or nothing, one commit for every file, the receipt.

---

## The Hermes card

The card at the top of Connections is the collector's **hermes** part, written to
`.agent-team/status/hermes/<computer>.json` (`agent-status/hermes/v1`). It comes from
`scripts/lib/status/hermes.mjs`, which **never calls `deps.exec`**: Hermes is never run, and no
other program is either. Everything is read from Hermes's own files.

**Where Hermes is.** The way Hermes works it out (`hermes_constants.py`): `HERMES_HOME`, else
`%LOCALAPPDATA%\hermes` on Windows, else `~/.hermes`. A `HERMES_HOME` of `<root>/profiles/<name>`
runs one profile; its root is used. The root is the profile Hermes calls `default`.

| Source | File | Kept | Never kept |
|---|---|---|---|
| Version | `hermes-agent/pyproject.toml`, or `hermes-agent/hermes_cli/__init__.py` | the number | every other line |
| Update | `.update_check` (`ts`, `ver`, `behind`) | `updateAvailable`, only when `ts` is under 7 days old and `ver` is the version installed | how far behind, the commit ids |
| Gateway | `gateway_state.json` | `gateway_state` and `updated_at` | `pid`, `argv` (the command line, with the username in its path), the chat apps and their ids, everything else |
| Profiles | `profiles/<name>/`, listed only when it holds one of Hermes's own profile files and has no tombstone in `profiles/.deleted/`; links are not followed | the name, if it passes Hermes's own id rule and the connection-name rule; else counted in `hidden`. Default first, then A to Z, 12 at most, the rest counted in `more` | - |
| Model | each profile's `config.yaml` | `model.default` (its last part after the last `/`) and `model.provider`, each only if it passes the connection-name rule; a provider only with a model | `base_url` and every other key. The file is read as lines: only the first-level `default` and `provider` lines of the top-level `model` block are matched |
| Skills | each profile's `skills/` folder | how many files are named `SKILL.md`, at any depth | the files themselves - none is opened, no link is followed |
| Sessions | each profile's `state.db`, through `node:sqlite`, **read-only** | for top-level sessions: how many started in the last 7 days (`conversations`: every source but `cron`, `delegate`, `subagent`; `scheduled`: `cron`), and the newest activity time | titles, working folders, users, chat ids, models, costs, messages - no such column is ever asked for |
| Scheduler | each profile's `cron/ticker_heartbeat` | the time in it (one number, seconds since 1970) | anything that is not that one number |

**Checked to exist, never opened:** `config.yaml`, `.env`, `SOUL.md`, `profile.yaml`, `auth.json`
and `state.db` - only to tell a real profile from a leftover folder - and the tombstone.
**Never touched at all:** `.env`, `auth.json`, `SOUL.md`, `USER.md`, `memories`, `logs`, the
`sessions` folder, `pairing`, `bot_relay`, every database but `state.db`.

**The one question to `state.db`.** The collector opens it read-only (SQLite itself then refuses
any write, and a missing file is never created), asks `PRAGMA table_info(sessions)` for the column
names, and then one `SELECT` made only of fixed words. Which fixed form it uses depends on which
of `parent_session_id`, `last_activity_at` and `ended_at` exist; a name read from the file is
never put into the question. A table without `source` or `started_at`, or a file that is not a
database, is `unavailable`. Without `node:sqlite` (Node 20, or 22 before 22.13) it is
`unavailable` with "needs a newer Node". Never 0: a zero would say Hermes was idle.

**Alive.** The file has no yes/no for it; the gate refuses one. The dashboard works it out: the
gateway is `running` with `updated_at` within 5 minutes of `takenAt`, or a listed profile's
scheduler beat is within 5 minutes of it. The same function (`aliveFrom` in
`scripts/lib/status/hermes-schema.mjs`) decides whether the collector writes
`runs/heartbeat/hermes.json` - `{ runtime, at }`, `at` the newest proof - in the same commit, behind
the same link checks. Down means no heartbeat, and the old one goes stale.

The contract is `tests/fixtures/hermes-parity.json`, byte for byte the same in the dashboard's repo:
the gateway states and their words, the alive rule with worked examples, the heartbeat settings
(Hermes's `stale_after_minutes` is 200), name examples, a full sample and the shape the board must
build from it.

The tests that hold this:

- `tests/status-hermes-contract.test.mjs` - the contract, the alive rule, the name rules, the gate.
- `tests/status-hermes.test.mjs` - every file above: the home rule, the version and update check,
  the gateway, which folders are profiles, the model lines, the skills count, the scheduler time,
  and the sessions question against real SQLite files (it never writes, asks two statements only,
  and never names a private column).
- `tests/status-hermes-run.test.mjs` - the heartbeat only when alive, one commit with the status
  files, the link check on `runs/heartbeat`, the log, a hostile Hermes home (keys in `.env` and
  `auth.json`, a keyed `base_url`, the username in the gateway's `argv`, private session titles and
  folders in `state.db`, `SOUL.md`, memories, logs) leaking nothing, and no program the exec door
  sees ever being Hermes.

---

## Not verified yet

- Hermes on the Mac: that it lives in `~/.hermes`, its version, its profiles, and that
  `gateway_state.json`, `state.db` and `cron/ticker_heartbeat` are there in the shape read here.
  All of it was read from the Hermes source and the Windows PC's copy only.
- The Mac's Node version: sessions need `node:sqlite`, Node 22.13 or newer.
- How long `claude mcp list` takes on the Mac with every server, and whether it writes to
  `~/.claude.json` while it runs.
- The exact state words it prints there, and whether claude.ai connectors appear in it from a
  LaunchAgent.
- Where Claude Code and Codex are installed on the Mac.
- Where every plugin keeps its servers. On the Windows PC some plugins' servers appear only in the
  live list.
- That `/usr/bin/plutil` reads each app's `Info.plist` from a LaunchAgent.

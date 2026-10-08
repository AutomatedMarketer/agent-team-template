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
| Hermes version | `hermes-agent/pyproject.toml` (`version` under `[project]`), or `hermes-agent/hermes_cli/__init__.py` (`__version__`) | the number | every other line |
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

## Not verified yet

- How long `claude mcp list` takes on the Mac with every server, and whether it writes to
  `~/.claude.json` while it runs.
- The exact state words it prints there, and whether claude.ai connectors appear in it from a
  LaunchAgent.
- Where Claude Code and Codex are installed on the Mac.
- Where every plugin keeps its servers. On the Windows PC some plugins' servers appear only in the
  live list.
- That `/usr/bin/plutil` reads each app's `Info.plist` from a LaunchAgent.

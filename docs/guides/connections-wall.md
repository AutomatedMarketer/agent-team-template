# The Connections wall on your dashboard

Your dashboard has a Connections page. It can show what each of your computers has set up. It
lists your AI tools and their versions. It lists the servers and plugins Claude Code and Codex
use. And it shows which ones work right now.

This guide shows you how to fill that wall. It takes a few minutes.

You do not need to write any code. You will run one command, or let Claude do it for you.

Want to know how it works underneath? Read
[How the Connections wall works](connections-wall-how-it-works.md).

---

## Words used in this guide

| Word | What it means |
|---|---|
| **Connection** | Anything your AI can reach out to: a tool, a server or a plugin |
| **Server** | A small program or web service that gives Claude extra skills. GitHub and Gmail are examples. They are also called MCP servers |
| **Plugin** | A bundle you install into Claude Code or Codex. Some plugins bring their own servers |
| **claude.ai connector** | A server you switched on at claude.ai. Claude Code can use it too |
| **Snapshot** | A small file with the list in it. It goes into your team repo, so the dashboard can read it |
| **Team repo** | Your own copy of this template, on GitHub. The dashboard reads from it |
| **Hermes** | An AI agent that runs all the time on your always-on computer. It can chat with you in apps and run jobs on a schedule |
| **Profile** | One of your Hermes agents. Each profile has its own model, skills and history. The first one is called "default" |
| **Heartbeat** | A tiny file that says "I was alive at this time". If it gets old, the dashboard says the agent has gone quiet |

---

## Before you start

- You need your **team repo** on this computer, opened in Claude Code.
- You need **Node.js 20 or newer**. Type `node --version` in a terminal to check.
- If you set up the usage meters, you are already set. The same script fills both.

---

## Fill the wall

There are two ways. Pick one.

**The easy way: ask Claude.**

1. Open your team repo in Claude Code.
2. Type `/snapshot` and press Enter.
3. Claude asks for a short name for this computer, like "Work laptop".
4. Claude runs the script and tells you what it found.

**By hand.**

1. Open a terminal in your team repo folder.
2. See what it would save, without saving anything:

   ```bash
   node scripts/collect-status.mjs --computer "Work laptop" --only connections --dry-run
   ```

3. If it looks right, save it and send it to your team repo:

   ```bash
   node scripts/collect-status.mjs --computer "Work laptop" --only connections --commit
   ```

4. Open your dashboard. Go to Connections.

The check can take up to 2 minutes. It asks every server whether it works, one by one.

**On an always-on computer** the same script runs every 3 hours by itself. It fills the usage
meters and the wall in one go. The Mac steps are in
[the status README](../../.agent-team/status/README.md#the-mac-schedule-phase-4-task-t14).

---

## What you will see

Each computer gets its own section, newest first. The top line says when it was checked.

**Servers** (Claude Code):

| Label | What it means |
|---|---|
| **Connected** | The server answered. It works |
| **Needs sign-in** | Shown in grey. It is not a problem. The server wants you to log in before it works. Some you leave signed out on purpose |
| **Failed** | The server did not answer. Open Claude Code and type `/mcp` to see why |
| **Waiting for approval** | Claude Code asks you to say yes to this server first |
| **Not checked** | The live check did not run, so only the list is known |
| **Seen before** | A claude.ai connector this computer has used before. It was not checked this time |
| **Unknown** | The server gave an answer the script does not know yet |

**The live check** (the line above the servers):

| Label | What it means |
|---|---|
| **Checked live** | Every server was asked whether it works |
| **Live check took too long** | It ran out of its 2 minutes. You see the list without live answers |
| **Live check could not run** | Claude Code could not be started safely. You see the list only |
| **Live check answer not understood** | Claude Code answered in a way the script does not read |
| **Claude Code not found** | The `claude` program is not on this computer, or not where the script looks |

**Codex** servers and plugins:

| Label | What it means |
|---|---|
| **Found** | It is set up in Codex |
| **Turned off** | It is set up, but switched off |

**Installed tools**:

| Label | What it means |
|---|---|
| **Found** | It is installed. The version number is next to it |
| **Not found** | It is not installed on this computer |
| **Could not check** | It may be there, but the script could not ask it safely. On Windows, the Claude and ChatGPT apps always say this |

**Proved** is different from all of these. **Proved** means you tested a connection by hand and
wrote that down in your connections list. The script never marks anything as **Proved**. Found is
not the same as proved.

Some servers belong to one project folder only. The wall counts them, but never shows their names.
A name that looks like a password or an email is never shown either. The wall says how many it
left out.

---

## The Hermes card

If this computer has **Hermes**, a card sits at the top of Connections. The same script fills it.
It never starts Hermes. It only reads the files Hermes keeps.

**Is it running?** The card says one of three things:

| Label | What it means |
|---|---|
| **Running** | Hermes was busy when the script checked. Its gateway or its scheduler had written its file in the last 5 minutes |
| **Down at last check** | At the last check, neither had written for more than 5 minutes. Hermes may be stopped |
| **Not checked for 9 h** | The last check is old, so the card cannot say. The always-on computer may be off. The number is the hours since the check |

**The version** says, for example, "Hermes 0.21.3 - update available". It says "update available"
or "up to date" only when Hermes checked for updates itself in the last week.

**Each profile** gets a row, the default one first:

- the **model** it uses, like "claude-opus-5-5 via anthropic"
- how many **skills** it has
- how many **conversations** and **scheduled runs** it had in the last 7 days
- when it was **last active**

If the row says "Not available (needs a newer Node)", update Node.js to 22.13 or newer. The other
parts of the card still work.

**What it never reads.** Hermes keeps private things too. The script never opens them:

- your Hermes **memories**, `SOUL.md` and `USER.md`
- your keys and sign-ins: `.env` and `auth.json`
- your chats, their titles, and the folders they ran in
- the logs

It only counts your sessions. To do that it copies Hermes's session list to a private folder,
counts, and deletes the copy, so Hermes's own files are never changed. It never reads what was said
in them.

**The Hermes light on the Machines list.** Each time Hermes is running, the script also writes a
**heartbeat**. To see it as a light, ask Claude: "add Hermes to my runtimes with a 200-minute
limit". The limit is 200 minutes because the script checks every 3 hours.

---

## What it never saves

The script reads Claude Code's and Codex's settings to find the names. Those settings hold much
more than names. None of that leaves your computer:

- no web address of any server
- no password, key or sign-in of any kind
- no command, setting or folder a server uses
- no project folder, and no project's own server names
- no email, and no username
- not the name of your computer: it uses the name you give it

If anything looks like a secret, the script stops. It saves nothing at all, and it tells you which
part it stopped on.

---

## If something looks wrong

- **The wall is empty.** Run `/snapshot` again, and check the dashboard after a minute.
- **Many servers say Failed.** Open Claude Code and type `/mcp`. It shows each server's error.
- **It says "older than 8 hours".** The always-on computer has not run for a while. Check that it is on.
- **A tool says Could not check.** That is fine. The script only runs programs it can run safely.

---

## How to switch it off

- To stop filling the wall, run the script with `--only usage`. That fills the usage meters only.
- To keep the wall but drop the Hermes card, use `--only usage,connections`.
- On the always-on Mac, add `--only usage` (or `--only usage,connections`) to the command in the
  schedule file.
- To clear what is already there, delete this computer's file in `.agent-team/status/connections/`
  and commit that.

# Usage meters on your dashboard

Your dashboard can show how much of your Claude plan you have used. It shows the 5-hour limit
and the weekly limit, and when each one resets. It can show Codex too, if you use it.

This guide shows you how to switch that on. It takes about five minutes.

You do not need to write any code. You will copy a command or two, or let Claude do it for you.

Want to know how it works underneath? Read [How the usage meters work](usage-meters-how-it-works.md).

---

## Words used in this guide

| Word | What it means |
|---|---|
| **Status line** | The thin bar at the bottom of Claude Code. It can show a short line of text |
| **The tap** | A tiny script that sits in that bar. It copies your usage numbers into a small file on your computer |
| **Snapshot** | A small file with your usage numbers in it. It goes into your team repo, so the dashboard can read it |
| **Team repo** | Your own copy of this template, on GitHub. The dashboard reads from it |
| **Always-on computer** | A computer that stays on all day, every day. A Mac Mini is the usual one |

---

## Before you start

- You need **Claude Pro or Max**. The meters show your plan's limits, and only those plans have them.
- You need your **team repo** on this computer, opened in Claude Code.
- You need **Node.js 20 or newer**. Type `node --version` in a terminal to check.

---

## Path A: let Claude set it up (easiest)

1. Open Claude Code in your team repo.
2. Type `/onboard`. The usage meters are in phase 11.
   - Already done onboarding? Just type: **set up my usage meters**.
3. Claude asks if there is a computer that is always on. Answer honestly. "No" is fine.
4. Claude explains the tap in one sentence and asks **yes or no**. Say **yes**.
5. Claude installs it for you. It runs `node scripts/install-usage-tap.mjs`.
6. **If you have an always-on Mac**, Claude walks you through a schedule. The Mac then sends fresh
   numbers every 3 hours, by itself.
7. **If you do not**, Claude shows you `/snapshot`. You run it whenever you want fresh numbers.

That is it. Skip to [What you will see](#what-you-will-see).

---

## Path B: do it by hand

Type these into a terminal, in your team repo folder.

1. **See what will change first.** Nothing is written yet:

   ```bash
   node scripts/install-usage-tap.mjs --dry-run
   ```

2. **Install the tap:**

   ```bash
   node scripts/install-usage-tap.mjs
   ```

   It saves a backup of your Claude Code settings first. It tells you where the backup went.

   It also puts a **copy of the tap** in a folder of its own, and runs that copy. Why: the tap runs
   after every reply. If it ran from your team repo, anyone who can change your repo could change
   what runs on your computer. A `git pull` does not change the copy by itself. To take a newer tap,
   run the installer again.

3. **Use Claude Code as normal.** Send it one message. After Claude's first reply, the bottom bar
   shows something like `5h 18% · wk 49%`.
   - Already had your own status line? You will still see yours. The tap works quietly behind it.

4. **Send the numbers to your dashboard.** In Claude Code, type:

   ```
   /snapshot
   ```

   It asks for a short name for this computer, like "Work laptop". Then it saves the snapshot and
   sends it to your team repo.

5. **Open your dashboard.** The numbers are in the **Plan limits** section on the Today screen.

Run `/snapshot` again whenever you want fresh numbers.

---

## What you will see

Each number on the dashboard has a small label. Here is what each label means.

| You see | What it means | Do you need to do anything? |
|---|---|---|
| **From Claude Code** | The official numbers. Claude Code gave them to the tap, and Anthropic documents them. Tap **Why?** under the meters and it says they came from Claude Code's status line | No |
| **saved copy** | A backup. Claude Code saved this reading in its own file on your computer | No |
| **unofficial** | Anthropic has not published the place this reading came from. It is right today, but it could stop working without warning. Only the backup methods get this label | No |
| **from Codex's own log** | The Codex numbers came from Codex's own records on your computer | No |
| **estimate** | A rough count of your Claude Code use, from its logs on this one computer. It is never shown as a percentage | No |
| **not found** | That thing is not on this computer. For example, no Codex numbers if you do not use Codex. This is normal | No |
| **unavailable** | It is there, but could not be read safely. A short reason is shown. No number is made up | Read the reason. Often: use Claude Code, then run `/snapshot` again |
| **reset since this reading** | The limit has reset since the reading was taken, so the old number no longer counts | No. Fresh numbers come with the next snapshot |
| **older than 8 hours** | The reading may be out of date | Run `/snapshot` again |

**The best label to see.** The tap's numbers come straight from Claude Code. They are the official
ones, so the dashboard shows them as **From Claude Code**, with no "unofficial" label.

**Which reading wins.** The tap only gets numbers while you are using Claude Code.

- Used Claude Code in the last 30 minutes? The tap's numbers are used.
- Longer ago? The snapshot tries a backup method first, because it is more up to date. That
  backup is marked **unofficial**.
- If the backup fails, the tap's numbers are still used, up to 6 hours old.
- Over 6 hours? Only the backup methods are left.

**What the tap shows.** It has only the 5-hour and weekly limits. Some plans also have a
per-model weekly limit, like "Weekly, Fable only". Only the backup methods can show that one.

---

## The Mac "Always Allow" box

You may only ever see this on a Mac. It is only for the **backup method**.

When the tap's reading is too old, the snapshot can ask your Mac for your Claude sign-in. It uses
the sign-in once, to ask Anthropic for your numbers. It never saves it or shows it.

The first time, macOS may show a box that says something like: **"security wants to use your
confidential information stored in 'Claude Code-credentials' in your keychain."** We have not yet
seen this box on our own Mac. The exact words may differ.

- **Always Allow** - the always-on Mac can use the backup method by itself, every 3 hours. Know what
  this grants: any program running as you can then read that one Keychain item without asking.
- **Deny** - fine too. The backup method is skipped. The tap's reading still works.

You only need **Always Allow** for an always-on Mac that runs by itself. On a laptop where you run
`/snapshot` by hand, you can click **Allow** each time, or **Deny**.

---

## How to undo everything

Do any of these. Each one is safe on its own.

1. **Take the tap out of Claude Code.** This puts back exactly the status line you had before, and
   deletes the copy of the tap:

   ```bash
   node scripts/install-usage-tap.mjs --remove
   ```

2. **Delete the small file the tap keeps.**

   On a Mac:

   ```bash
   rm -rf ~/.local/state/agent-status
   ```

   On Windows, in PowerShell:

   ```powershell
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agent-status"
   ```

3. **Delete the settings backups**, if you want. They sit in your `.claude` folder, named
   `settings.json.before-usage-tap-<date>.bak`. Keep them until you are sure all is well.

4. **Stop the Mac schedule**, if you set one up. Follow the "Rollback" steps in
   [the status README](../../.agent-team/status/README.md#rollback).

5. **Take the numbers off the dashboard.** Delete the snapshot file from your team repo, then commit
   and push. The file is `.agent-team/status/usage/<your-computer-name>.json`.

---

## If something looks wrong

| What you see | What to do |
|---|---|
| The bottom bar shows nothing new after installing | Send Claude a message first. The numbers come after the first reply. Pro and Max only |
| The bottom bar went blank | Run `node scripts/install-usage-tap.mjs --remove` to put your old one back. Then tell Claude what happened |
| "Nothing changed: your status line already runs usage-tap.mjs..." | You added the tap by hand before. The installer leaves that alone. Edit it yourself, or remove it first |
| "settings.json is not plain JSON" | Your Claude Code settings file has a comment or a stray comma in it. Fix that first. Nothing was changed |
| The dashboard says **unavailable** | Read the reason under it. Use Claude Code for one reply, then run `/snapshot` again |
| You pulled a newer team repo and want the newer tap | Run the installer again: `node scripts/install-usage-tap.mjs`. The copy never changes by itself |

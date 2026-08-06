# Routine runtime — measured

**Status:** pending
**Blocked on:** a live claude.ai Pro or Max account. Nobody but the account holder can run
this, and no amount of documentation substitutes for it.
**Blocks:** Lesson 6 (First Routine), Lesson 8 (Email Agent), Lesson 13 (Team Day), and
course gate G-1 in the acceptance criteria.

Fill this in, change **Status:** to `measured`, and `npm test` will start enforcing that
every cell is answered.

---

## How to run it

1. Open `claude.ai/settings/usage`. Record the plan tier and the exact wording of anything
   the page says about routines. Screenshot it into this folder.
2. Push this repo to GitHub, private for now.
3. Create one routine pointed at it. Set the model selector to **Opus** for the first run
   and **Sonnet** for the second, while `.claude/settings.json` says `opus` throughout.
   Use this prompt:

   ```
   Read .claude/settings.json and report the model and effort level this session is
   actually running with, exactly as the startup header shows them. Then write a run-log
   entry for agent "research" with trigger "schedule" following
   .claude/skills/run-log/SKILL.md, put the startup header text in the evidence array,
   and commit it.
   ```

4. Add `CLAUDE_CODE_EFFORT_LEVEL=medium` as an environment variable on the cloud
   environment, run once more, and see whether the header changes.
5. Press **Run now** repeatedly until it refuses. Record the count and the exact wording.

---

## Findings

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Does the routine model selector override `.claude/settings.json`? | | |
| 2 | Does `effortLevel` from the repo reach a cloud run? | | |
| 3 | What is the real session URL? | | |
| 4 | Can the cloud environment set `CLAUDE_CODE_EFFORT_LEVEL`? | | |
| 5 | How many runs before the cap refuses? | | |
| 6 | Exact refusal wording | | |

## What this changes

| Decision | Current assumption | After measuring |
|---|---|---|
| Email agent schedule | 3 runs/day (07:00, 12:00, 17:00) | |
| Required plan floor in pre-flight | Pro | |
| The "$0 extra" claim | Holds | |
| `session_url` format in `runs/README.md` | `https://claude.ai/code/session_<id>` | |
| Per-agent effort control | Not possible; one `effortLevel` per repo | |

## If the session URL shape is different

Change the `startsWith` check in `scripts/lib/run-log.mjs`, the field table in
`runs/README.md`, and step 1 of `.claude/skills/run-log/SKILL.md` in one commit, then run
`npm test`.

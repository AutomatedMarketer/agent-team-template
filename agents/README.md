# agents/ — where your team keeps its work

Two different things share the word "agent" in this repo, and it is worth being clear:

| Where | What it is |
|---|---|
| `.claude/agents/<slug>.md` | The **definition** — the instructions, and the model it runs on. Claude Code loads these, on your laptop and in the cloud. |
| `agents/<slug>/` | The **workspace** — what the agent produced, and the reference material you maintain for it. |

Inside a workspace:

| Folder | Holds |
|---|---|
| `output/` | Everything the agent wrote. Dated filenames. This is what you read. |
| `knowledge/` | Reference you keep up to date — the FAQ, the offer sheet. Only some agents have one. |

One workspace is special: `agents/orchestrator/` belongs to the front door itself — the
role `CLAUDE.md` describes, registered in `.claude/agents/orchestrator.md` so the daily
task sweep can be owned by the role that routes work. Its output stays nearly empty on
purpose: the work it routes lands in the doing specialist's workspace.

Deleting a file in `output/` deletes a piece of your history. The run log in `runs/` still
records that it happened, so the cockpit will show the gap.

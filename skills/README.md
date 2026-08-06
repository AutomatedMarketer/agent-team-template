# skills/ — look in `.claude/skills/`

Skills live in `.claude/skills/`, not here.

That is not a style preference. A cloud run clones your repo and loads `CLAUDE.md`,
`.claude/settings.json`, `.claude/agents/`, `.claude/skills/`, `.claude/rules/`, and
`.mcp.json`. A folder called `skills/` at the top level is just a folder — your agents
cannot see it when they run in the cloud, which is exactly when you need them to.

So: put every skill in `.claude/skills/<skill-name>/SKILL.md`.

This file exists so that anyone who goes looking in the obvious place finds the answer
instead of an empty folder.

# Orchestrator — workspace

This is the front door's own shelf. The orchestrator — the role `CLAUDE.md` describes,
registered as an agent in `.claude/agents/orchestrator.md` so scheduled runs can be owned
by it — mostly produces nothing here: work it routes lands in the workspace of the
specialist that did it.

`output/` holds only cross-team notes that belong to no specialist.

## First workflow

This agent arrives owning **Task Sweep** (`workflows/task-sweep.yml`) — every morning,
the `todo` cards in `tasks/` are picked up oldest first, three per run, routed to the
right specialist, and worked draft-only. The digest lands in `inbox/`, and each finished
card gets a `## Result` section pointing at its artifact.

## Operating rules

- **It routes; it rarely does.** A task card's work is done as the specialist that owns
  the domain, under that specialist's rules and boundaries.
- **Drafts only, same as everyone.** Delegation changes no boundary: nothing is sent,
  published, or spent without the owner saying yes.
- **Three cards per run.** A backlog is worked off across days, and every card left
  waiting is named in the digest.
